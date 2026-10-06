/**
 * E.1 communication safety and truthfulness: consent at send time, the outbound
 * message record (pending → sent / failed / unknown), duplicate protection,
 * truthful AI replies, and automated-email unsubscribe.
 *
 * The real code runs unmodified: deliverMessageToContact, the outbound message
 * record, the live journey executor and engine, the provider senders, the
 * inbound handlers and the agent's compliance path, and the unsubscribe flow.
 * Supabase is PGlite behind the PostgREST bridge (with the real migration 064);
 * Telnyx, Resend, and Meta are recorded fakes. Only the AI model turn is a fake.
 * live-actions-test-env.ts must be the first import; it fails closed on any
 * other network access.
 */

import { attachTestDb, blockedRequests, LIVE_ACTIONS_SCHEMA, providers } from "./live-actions-test-env.ts";

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, afterEach, beforeEach, describe, it } from "node:test";
import type { JourneyAIExecutor } from "./ai.ts";
import type { ActionConfig } from "./contracts.ts";
import { dispatchJourneyEvent, JourneyStepError, resumeDueRuns, type ActionInput, type EngineDeps, type JourneyEvent } from "./engine.ts";
import type { JourneySnapshot, SnapshotNode } from "./graph.ts";
import { createTestDb } from "./lead-status-test-db.ts";
import { MemoryJourneyStore } from "./memory-store.ts";
import type { ContactContext } from "../../coordinator.ts";
import type { InboundTurnDeps } from "../../inbound-turn.ts";
import type { InboundAgentResult } from "../../run-inbound-agent.ts";

// Range filters on: the Meta echo check looks back two minutes.
const db = await createTestDb({ schema: LIVE_ACTIONS_SCHEMA, rangeFilters: true });
attachTestDb(db);
const { createLiveActionExecutor } = await import("./live-actions.ts");
const { deliverMessageToContact, AMBIGUOUS_SEND_ERROR } = await import("../../messaging/deliver-message.ts");
const { beginOutboundMessage, recordOutboundOutcome, recordReplyOutcome } = await import("../../messaging/outbound-messages.ts");
const { automatedEmailUnsubscribe, manualEmailUnsubscribeBlock, unsubscribeFromAutomatedEmail } = await import("../../email/unsubscribe.ts");
const { signUnsubscribeToken } = await import("../../email/unsubscribe-token.ts");
const { handleInboundSms, sendAgentSmsReply } = await import("../../handle-inbound.ts");
const { handleInboundMetaMessage } = await import("../../handle-inbound-meta.ts");
const { claimInboundMessage, getRecentMessages } = await import("../../db/contacts.ts");
const { liveBackend } = await import("../../agent/live-backend.ts");
const { runInboundAgent } = await import("../../run-inbound-agent.ts");
const { sendSmsMessage } = await import("../../messaging/send-sms.ts");
const { clearPlatformSecretCache } = await import("../../admin/platform-secrets.ts");

const service = db.client("service_role");
const executor = createLiveActionExecutor(service);
const AGENT = randomUUID();
const PRIMARY = "+15559990000";
const START = new Date("2026-10-06T12:00:00.000Z");

let tenant: string;
let clock: Date;
let store: MemoryJourneyStore;
let deps: EngineDeps;

const ai: JourneyAIExecutor = { execute: async () => ({ success: true, output: {}, text: "" }) };

after(async () => {
  await db.pg.close();
});

beforeEach(async () => {
  await db.reset();
  providers.reset();
  clearPlatformSecretCache();
  tenant = await newTenant();
  clock = START;
  store = new MemoryJourneyStore(() => clock);
  deps = { store, actions: executor, ai, now: () => clock };
});

afterEach(() => {
  assert.deepEqual(blockedRequests, [], "no request may leave the test environment");
});

// ---------- Seed helpers (direct SQL, outside the code under test) ----------

async function newTenant(): Promise<string> {
  const [{ id }] = await db.query<{ id: string }>("insert into public.tenants default values returning id");
  await db.query("insert into public.tenant_phone_numbers (tenant_id, phone_e164, is_primary) values ($1, $2, true)", [id, PRIMARY]);
  for (const channel of ["messenger", "instagram"]) {
    await db.query(
      `insert into public.channel_accounts (tenant_id, channel, external_page_id, external_account_id, status, metadata)
       values ($1, $2, $3, $4, 'connected', $5)`,
      [id, channel, `page-${channel}-${id}`, `acct-${channel}-${id}`, JSON.stringify({ access_token: `token-${channel}` })],
    );
  }
  await db.query("insert into public.memberships (tenant_id, user_id, role) values ($1, $2, 'member') on conflict do nothing", [id, AGENT]);
  return id;
}

async function seedAgentProfile() {
  await db.query("insert into public.profiles (id, display_name, reply_to_email) values ($1, 'Jordan Agent', 'jordan@agency.test') on conflict do nothing", [AGENT]);
  db.authUsers.set(AGENT, { email: "jordan.login@agency.test" });
}

/** A lead reachable on SMS, Messenger, Instagram, and email. */
async function newLead(state: { opted_out?: boolean; handoff?: boolean; tenantId?: string } = {}) {
  const tenantId = state.tenantId ?? tenant;
  const [{ id }] = await db.query<{ id: string }>(
    `insert into public.contacts (tenant_id, first_name, last_name, email, assigned_agent_id, opted_out, handoff)
     values ($1, 'Ana', 'Lima', 'ana@example.com', $2, $3, $4) returning id`,
    [tenantId, AGENT, state.opted_out ?? false, state.handoff ?? false],
  );
  await db.query(
    "insert into public.contact_identities (contact_id, channel, external_id) values ($1, 'sms', $2), ($1, 'messenger', $3), ($1, 'instagram', $4)",
    [id, `+1555${String(Math.floor(Math.random() * 1e7)).padStart(7, "0")}`, `psid-${id}`, `igsid-${id}`],
  );
  const [lead] = await db.query<Record<string, unknown>>("select * from public.contacts where id = $1", [id]);
  store.contacts.set(id, { tenantId, lead });
  return id;
}

async function addInbound(contactId: string, channel: string, minutesAgo = 5, tenantId = tenant) {
  await db.query(
    `insert into public.messages (tenant_id, contact_id, channel, direction, body, created_at)
     values ($1, $2, $3, 'inbound', 'Hi there', now() - make_interval(mins => $4))`,
    [tenantId, contactId, channel, minutesAgo],
  );
}

interface MessageRow {
  id: string;
  tenant_id: string;
  contact_id: string;
  channel: string;
  direction: string;
  body: string;
  send_status: string | null;
  send_error: string | null;
  provider_message_id: string | null;
  idempotency_key: string | null;
}

function outbound(tenantId = tenant): Promise<MessageRow[]> {
  return db.query<MessageRow>("select * from public.messages where direction = 'outbound' and tenant_id = $1 order by created_at, id", [tenantId]);
}

async function withoutPrivilege<T>(table: string, privilege: "insert" | "update" | "select", work: () => Promise<T>): Promise<T> {
  await db.query(`revoke ${privilege} on public.${table} from service_role`);
  try {
    return await work();
  } finally {
    await db.query(`grant ${privilege} on public.${table} to service_role`);
  }
}

async function inputFor(contactId: string, ids: { runId?: string; nodeId?: string } = {}): Promise<ActionInput> {
  const [lead] = await db.query<Record<string, unknown>>("select * from public.contacts where id = $1", [contactId]);
  return { tenantId: tenant, runId: ids.runId ?? randomUUID(), nodeId: ids.nodeId ?? "node", contactId, lead, opportunity: null };
}

const sms = (contactId: string, extra: { automated?: boolean; idempotencyKey?: string; body?: string; tenantId?: string } = {}) =>
  deliverMessageToContact(service, {
    tenantId: extra.tenantId ?? tenant,
    contactId,
    channel: "sms",
    body: extra.body ?? "Hi Ana",
    automated: extra.automated,
    idempotencyKey: extra.idempotencyKey,
  });

const timeout = () => Object.assign(new Error("The operation was aborted due to timeout"), { name: "TimeoutError" });

async function rejectsWith(promise: Promise<unknown>, kind: "config" | "transient", message: string | RegExp) {
  await assert.rejects(promise, (error: unknown) => {
    assert.ok(error instanceof JourneyStepError, `expected a JourneyStepError, got ${String(error)}`);
    assert.equal(error.kind, kind);
    if (typeof message === "string") assert.equal(error.message, message);
    else assert.match(error.message, message);
    return true;
  });
}

// ---------- Journey helpers ----------

function linear(actions: ActionConfig[]): JourneySnapshot {
  const nodes: SnapshotNode[] = [
    { id: "t", type: "trigger", name: "Trigger", description: "", config: { event: "lead.created", filters: [] } },
    ...actions.map((config, index) => ({
      id: `a${index + 1}`,
      type: "action" as const,
      name: `Step ${index + 1}`,
      description: "",
      config: config as unknown as Record<string, unknown>,
    })),
  ];
  return {
    nodes,
    connections: nodes.slice(1).map((node, index) => ({
      id: `c${index}`,
      sourceNodeId: nodes[index].id,
      targetNodeId: node.id,
      sourceHandle: null,
      targetHandle: null,
    })),
  };
}

function leadEvent(contactId: string): JourneyEvent {
  return { tenantId: tenant, type: "lead.created", sourceId: randomUUID(), contactId, entityType: "contact", entityId: contactId, payload: {} };
}

function onlyRun() {
  const runs = [...store.runs.values()];
  assert.equal(runs.length, 1);
  return runs[0];
}

function attemptsOf(runId: string, nodeId: string) {
  return store.stepsFor(runId).filter((step) => step.nodeId === nodeId);
}

async function later(minutes: number) {
  clock = new Date(clock.getTime() + minutes * 60_000);
  await resumeDueRuns(deps);
}

const SMS_STEP = { action: "send_sms", body: "Hi {{first_name}}" } as const;
const EMAIL_STEP = { action: "send_email", subject: "Hi {{first_name}}", body: "Hello" } as const;
const WAIT = { action: "wait", duration: 1, unit: "days" } as const;

// ---------- Outbound truth: provider outcomes ----------

describe("outbound truth: the message row records what the provider said", () => {
  it("accepted with an id: the row is sent with the provider id; accepted is not delivered (no delivery claim)", async () => {
    const lead = await newLead();
    const result = await sms(lead);
    assert.equal(result.ok, true);
    assert.equal(result.ok && result.providerMessageId, "telnyx-msg-1");
    const [row] = await outbound();
    assert.equal(row.send_status, "sent");
    assert.equal(row.provider_message_id, "telnyx-msg-1");
    assert.equal(row.send_error, null);
  });

  it("accepted without an id: sent, with no provider id (Telnyx/Meta)", async () => {
    const lead = await newLead();
    providers.telnyx.respondNext(200, { data: {} });
    const result = await sms(lead);
    assert.equal(result.ok, true);
    const [row] = await outbound();
    assert.equal(row.send_status, "sent");
    assert.equal(row.provider_message_id, null);
  });

  it("rejected (4xx): failed, with the provider's reason, and reported as retryable", async () => {
    const lead = await newLead();
    providers.telnyx.respondNext(422, { errors: [{ detail: "Invalid destination" }] });
    const result = await sms(lead);
    assert.deepEqual(result.ok ? null : result.kind, "transient");
    const [row] = await outbound();
    assert.equal(row.send_status, "failed");
    assert.match(row.send_error ?? "", /Invalid destination/);
  });

  it("an ambiguous error (5xx): unknown, never reported as sent or as safely retryable", async () => {
    const lead = await newLead();
    providers.telnyx.respondRawNext(503, "<html>upstream</html>");
    const result = await sms(lead);
    assert.equal(result.ok, false);
    assert.equal(!result.ok && result.kind, "ambiguous");
    const [row] = await outbound();
    assert.equal(row.send_status, "unknown");
    assert.match(row.send_error ?? "", /may have been sent/);
  });

  it("a timeout after the request left: unknown", async () => {
    const lead = await newLead();
    providers.telnyx.throwNext(timeout());
    const result = await sms(lead);
    assert.equal(!result.ok && result.kind, "ambiguous");
    assert.equal(providers.telnyx.calls.length, 1, "the request reached the provider");
    const [row] = await outbound();
    assert.equal(row.send_status, "unknown");
    assert.match(row.send_error ?? "", /timed out/);
  });

  it("Meta: accepted → sent with the mid; rejected → failed; 5xx → unknown", async () => {
    const lead = await newLead();
    await addInbound(lead, "messenger");
    const dm = () => deliverMessageToContact(service, { tenantId: tenant, contactId: lead, channel: "messenger", body: "Hi", automated: true });
    assert.equal((await dm()).ok, true);
    providers.meta.respondNext(400, { error: { message: "(#10) outside window" } });
    assert.equal(((await dm()) as { kind: string }).kind, "transient");
    providers.meta.respondNext(500, { error: { message: "oops" } });
    assert.equal(((await dm()) as { kind: string }).kind, "ambiguous");
    assert.deepEqual(
      (await outbound()).map((row) => [row.send_status, row.provider_message_id]),
      [["sent", "m_meta_1"], ["failed", null], ["unknown", null]],
    );
  });

  it("the row is written before the provider is called: a failed write sends nothing", async () => {
    const lead = await newLead();
    const result = await withoutPrivilege("messages", "insert", () => sms(lead));
    assert.equal(!result.ok && result.kind, "transient");
    assert.equal(providers.telnyx.calls.length, 0);
  });

  it("(fault 1) provider accepted but the outcome write failed: the row stays pending (unconfirmed), never sent, never resent", async () => {
    const lead = await newLead();
    const key = `journey:${randomUUID()}:a1`;
    const first = await withoutPrivilege("messages", "update", () => sms(lead, { automated: true, idempotencyKey: key }));
    assert.equal(first.ok, true, "the provider accepted it; the caller is told so");
    const [row] = await outbound();
    assert.equal(row.send_status, "pending");
    const retry = await sms(lead, { automated: true, idempotencyKey: key });
    assert.deepEqual(retry, { ok: false, error: AMBIGUOUS_SEND_ERROR, kind: "ambiguous" });
    assert.equal(providers.telnyx.calls.length, 1);
  });

  it("(fault 4) a provider id already recorded on another message: the second row is sent without the id, never dropped or left pending", async () => {
    const lead = await newLead();
    providers.telnyx.respondNext(200, { data: { id: "dup-1" } });
    providers.telnyx.respondNext(200, { data: { id: "dup-1" } });
    await sms(lead, { body: "one" });
    const second = await sms(lead, { body: "two" });
    assert.equal(second.ok, true);
    const rows = await outbound();
    assert.deepEqual(rows.map((row) => [row.body, row.send_status, row.provider_message_id]), [
      ["one", "sent", "dup-1"],
      ["two", "sent", null],
    ]);
    assert.match(rows[1].send_error ?? "", /already recorded/);
  });

  it("an outcome is recorded once: a second record on a settled row changes nothing", async () => {
    const lead = await newLead();
    await sms(lead);
    const [row] = await outbound();
    assert.equal(await recordOutboundOutcome({ tenantId: tenant, messageId: row.id, outcome: { status: "failed", error: "late" } }), false);
    assert.equal((await outbound())[0].send_status, "sent");
  });
});

// ---------- Duplicate protection ----------

describe("duplicate protection (idempotency key)", () => {
  it("(fault 3) a repeat after a confirmed acceptance returns the earlier message and never resends", async () => {
    const lead = await newLead();
    const key = `journey:${randomUUID()}:a1`;
    const first = await sms(lead, { automated: true, idempotencyKey: key });
    const second = await sms(lead, { automated: true, idempotencyKey: key });
    assert.equal(providers.telnyx.calls.length, 1);
    assert.equal(second.ok && second.deduplicated, true);
    assert.equal(second.ok && first.ok && second.messageId, first.ok && first.messageId);
    assert.equal(second.ok && second.providerMessageId, "telnyx-msg-1");
    assert.equal((await outbound()).length, 1);
  });

  it("a confirmed rejection may be retried: the same row is claimed back and sent", async () => {
    const lead = await newLead();
    const key = `journey:${randomUUID()}:a1`;
    providers.telnyx.respondNext(422, { errors: [{ detail: "Carrier rejected" }] });
    await sms(lead, { automated: true, idempotencyKey: key });
    const retry = await sms(lead, { automated: true, idempotencyKey: key });
    assert.equal(retry.ok, true);
    assert.equal(providers.telnyx.calls.length, 2);
    const rows = await outbound();
    assert.equal(rows.length, 1);
    assert.equal(rows[0].send_status, "sent");
    assert.equal(rows[0].send_error, null);
    assert.equal(rows[0].provider_message_id, "telnyx-msg-2");
  });

  it("(fault 2) an ambiguous outcome is never retried automatically", async () => {
    const lead = await newLead();
    const key = `journey:${randomUUID()}:a1`;
    providers.telnyx.throwNext(timeout());
    await sms(lead, { automated: true, idempotencyKey: key });
    for (let i = 0; i < 3; i++) {
      assert.deepEqual(await sms(lead, { automated: true, idempotencyKey: key }), { ok: false, error: AMBIGUOUS_SEND_ERROR, kind: "ambiguous" });
    }
    assert.equal(providers.telnyx.calls.length, 1);
  });

  it("crash before the provider call: the pending row blocks a blind resend", async () => {
    const lead = await newLead();
    const key = `journey:${randomUUID()}:a1`;
    const attempt = await beginOutboundMessage({ tenantId: tenant, contactId: lead, channel: "sms", body: "Hi Ana", idempotencyKey: key });
    assert.equal(attempt.status, "ready");
    // The process dies here, before the provider call.
    const retry = await sms(lead, { automated: true, idempotencyKey: key });
    assert.equal(!retry.ok && retry.kind, "ambiguous");
    assert.equal(providers.telnyx.calls.length, 0);
    assert.equal((await outbound())[0].send_status, "pending", "never shown as sent");
  });

  it("two concurrent sends of the same logical message: exactly one provider call", async () => {
    const lead = await newLead();
    const key = `journey:${randomUUID()}:a1`;
    const results = await Promise.all([sms(lead, { automated: true, idempotencyKey: key }), sms(lead, { automated: true, idempotencyKey: key })]);
    assert.equal(providers.telnyx.calls.length, 1);
    assert.equal((await outbound()).length, 1);
    assert.equal(results.filter((result) => result.ok && !result.deduplicated).length, 1, "one real send");
  });

  it("sends without a key are independent messages (manual sends)", async () => {
    const lead = await newLead();
    await sms(lead);
    await sms(lead);
    assert.equal(providers.telnyx.calls.length, 2);
  });
});

// ---------- Journey retry semantics through the engine ----------

describe("journey retry semantics (engine + live executor)", () => {
  it("a rejected SMS is retried on the backoff and sent once; one message row", async () => {
    const lead = await newLead();
    store.saveJourney(tenant, "j", linear([SMS_STEP]));
    providers.telnyx.respondNext(422, { errors: [{ detail: "Try later" }] });
    await dispatchJourneyEvent(deps, leadEvent(lead));
    assert.equal(onlyRun().status, "waiting");
    await later(2);
    const run = onlyRun();
    assert.equal(run.status, "completed");
    assert.equal(providers.telnyx.calls.length, 2);
    const rows = await outbound();
    assert.equal(rows.length, 1);
    assert.equal(rows[0].send_status, "sent");
    assert.equal(rows[0].idempotency_key, `journey:${run.id}:a1`);
  });

  it("an ambiguous SMS fails the step without a retry; later passes send nothing", async () => {
    const lead = await newLead();
    store.saveJourney(tenant, "j", linear([SMS_STEP]));
    providers.telnyx.respondNext(503, { errors: [{ detail: "Service unavailable" }] });
    await dispatchJourneyEvent(deps, leadEvent(lead));
    const run = onlyRun();
    assert.equal(run.status, "failed");
    assert.match(run.error ?? "", /may have been sent/);
    await later(60);
    assert.equal(providers.telnyx.calls.length, 1);
    assert.equal(attemptsOf(run.id, "a1").length, 1);
    assert.equal((await outbound())[0].send_status, "unknown");
  });

  it("crash after acceptance but before the step was saved: the re-run step returns the earlier message", async () => {
    const lead = await newLead();
    const ids = { runId: randomUUID(), nodeId: "a1" };
    const first = await executor.execute(SMS_STEP, await inputFor(lead, ids));
    // The step's completion is lost; the engine runs the same node again.
    const again = await executor.execute(SMS_STEP, await inputFor(lead, ids));
    assert.equal(providers.telnyx.calls.length, 1);
    assert.equal(again.status, "completed");
    assert.equal(again.output?.message_id, first.output?.message_id);
    assert.equal(again.output?.provider_message_id, "telnyx-msg-1");
  });

  it("two concurrent engine passes over a due run send the SMS once", async () => {
    const lead = await newLead();
    store.saveJourney(tenant, "j", linear([WAIT, SMS_STEP]));
    await dispatchJourneyEvent(deps, leadEvent(lead));
    clock = new Date(START.getTime() + 2 * 24 * 60 * 60_000);
    await Promise.all([resumeDueRuns(deps), resumeDueRuns(deps)]);
    assert.equal(providers.telnyx.calls.length, 1);
    assert.equal(onlyRun().status, "completed");
    assert.equal((await outbound()).length, 1);
  });

  it("an email step whose outcome was unknown fails without a retry, like SMS; later passes send nothing", async () => {
    await seedAgentProfile();
    const lead = await newLead();
    store.saveJourney(tenant, "j", linear([EMAIL_STEP]));
    providers.resend.throwNext(timeout());
    await dispatchJourneyEvent(deps, leadEvent(lead));
    const run = onlyRun();
    assert.equal(run.status, "failed");
    assert.match(run.error ?? "", /may have been sent/);
    await later(60);
    assert.equal(providers.resend.calls.length, 1);
    assert.equal(providers.resend.calls[0].idempotencyKey, `journey:${run.id}:a1`);
    assert.equal(attemptsOf(run.id, "a1").length, 1);
    const emails = await db.query<{ status: string; idempotency_key: string }>("select status, idempotency_key from public.crm_emails");
    assert.deepEqual(emails, [{ status: "unknown", idempotency_key: `journey:${run.id}:a1` }]);
  });
});

// ---------- Consent ----------

describe("consent at send time", () => {
  it("SMS: an opted-out contact is never texted, automated or manual", async () => {
    const lead = await newLead({ opted_out: true });
    assert.equal(((await sms(lead, { automated: true })) as { suppressed?: string }).suppressed, "opted_out");
    assert.equal(((await sms(lead)) as { suppressed?: string }).suppressed, "opted_out");
    assert.equal(providers.telnyx.calls.length, 0);
    assert.equal((await outbound()).length, 0);
  });

  it("Messenger and Instagram: opt-out suppresses automated sends", async () => {
    const lead = await newLead({ opted_out: true });
    for (const channel of ["messenger", "instagram"] as const) {
      await addInbound(lead, channel);
      const result = await deliverMessageToContact(service, { tenantId: tenant, contactId: lead, channel, body: "Hi", automated: true });
      assert.equal(!result.ok && result.suppressed, "opted_out", channel);
    }
    assert.equal(providers.meta.calls.length, 0);
  });

  it("Messenger and Instagram: automated sends need an inbound message on that channel in the last 24 hours", async () => {
    const lead = await newLead();
    const dm = (channel: "messenger" | "instagram") =>
      deliverMessageToContact(service, { tenantId: tenant, contactId: lead, channel, body: "Hi", automated: true });
    assert.equal(((await dm("messenger")) as { suppressed?: string }).suppressed, "outside_messaging_window");
    await addInbound(lead, "messenger", 25 * 60);
    assert.equal(((await dm("messenger")) as { suppressed?: string }).suppressed, "outside_messaging_window");
    await addInbound(lead, "instagram", 5);
    assert.equal(((await dm("messenger")) as { suppressed?: string }).suppressed, "outside_messaging_window", "Instagram doesn't open Messenger");
    assert.equal((await dm("instagram")).ok, true);
    await addInbound(lead, "messenger", 23 * 60);
    assert.equal((await dm("messenger")).ok, true);
    assert.equal(providers.meta.calls.length, 2);
  });

  it("(fault 6) consent is read at send time: an opt-out after the run loaded the lead still stops the send", async () => {
    const lead = await newLead();
    store.saveJourney(tenant, "j", linear([WAIT, SMS_STEP, EMAIL_STEP]));
    await seedAgentProfile();
    await dispatchJourneyEvent(deps, leadEvent(lead));
    await db.query("update public.contacts set opted_out = true, email_unsubscribed_at = now() where id = $1", [lead]);
    assert.equal(store.contacts.get(lead)!.lead.opted_out, false, "the run's lead is stale");
    await later(2 * 24 * 60);
    const run = onlyRun();
    assert.equal(run.status, "completed");
    assert.deepEqual(
      store.stepsFor(run.id).filter((step) => step.nodeId !== "t" && step.nodeId !== "a1").map((step) => [step.status, step.output?.skipped_reason]),
      [["skipped", "opted_out"], ["skipped", "unsubscribed"]],
    );
    assert.equal(providers.telnyx.calls.length + providers.resend.calls.length, 0);
  });

  it("(fault 8) handoff suppresses every automated channel (D.1 regression)", async () => {
    const lead = await newLead({ handoff: true });
    await addInbound(lead, "messenger");
    await addInbound(lead, "instagram");
    for (const channel of ["sms", "messenger", "instagram"] as const) {
      const result = await deliverMessageToContact(service, { tenantId: tenant, contactId: lead, channel, body: "Hi", automated: true });
      assert.equal(!result.ok && result.suppressed, "handoff", channel);
    }
    assert.equal(providers.telnyx.calls.length + providers.meta.calls.length, 0);
  });

  const manual = (contactId: string, channel: "sms" | "messenger" | "instagram") =>
    deliverMessageToContact(service, { tenantId: tenant, contactId, channel, body: "Following up" });

  it("(fault 9) handoff is an automation rule: a person can still text and DM a handed-off contact", async () => {
    const handedOff = await newLead({ handoff: true });
    await addInbound(handedOff, "messenger");
    await addInbound(handedOff, "instagram");
    for (const channel of ["sms", "messenger", "instagram"] as const) {
      assert.equal((await manual(handedOff, channel)).ok, true, `manual ${channel} during handoff`);
    }
    assert.equal(providers.telnyx.calls.length, 1);
    assert.equal(providers.meta.calls.length, 2);
  });

  it("opt-out is a consent rule: a person can't text or DM an opted-out contact either, even inside Meta's window", async () => {
    const optedOut = await newLead({ opted_out: true });
    await addInbound(optedOut, "messenger");
    await addInbound(optedOut, "instagram");
    for (const channel of ["sms", "messenger", "instagram"] as const) {
      const result = await manual(optedOut, channel);
      assert.equal(!result.ok && result.suppressed, "opted_out", `manual ${channel}`);
    }
    assert.equal(providers.telnyx.calls.length + providers.meta.calls.length, 0);
    assert.equal((await outbound()).length, 0);
  });

  it("Meta's 24-hour window is a platform rule: a manual DM outside it isn't sent", async () => {
    const lead = await newLead();
    await addInbound(lead, "messenger", 25 * 60);
    for (const channel of ["messenger", "instagram"] as const) {
      const result = await manual(lead, channel);
      assert.equal(!result.ok && result.suppressed, "outside_messaging_window", `manual ${channel}`);
      assert.match((result as { error: string }).error, /Meta only allows messages within 24 hours/);
    }
    assert.equal(providers.meta.calls.length, 0);
    await addInbound(lead, "messenger", 5);
    assert.equal((await manual(lead, "messenger")).ok, true);
  });

  it("re-opt-in: texting START over SMS subscribes the contact again, and automated SMS resumes", async () => {
    const lead = await newLead({ opted_out: true });
    const [{ external_id: phone }] = await db.query<{ external_id: string }>(
      "select external_id from public.contact_identities where contact_id = $1 and channel = 'sms'",
      [lead],
    );
    const ctx: ContactContext = {
      phone,
      accountId: tenant,
      contactId: lead,
      leadStatus: "New",
      readyToBook: false,
      apptBooked: false,
      handoff: false,
      optedOut: true,
    };
    const turn: InboundTurnDeps = { claim: claimInboundMessage, runAgent: runInboundAgent, dispatchSoon: () => {} };
    const reply = await handleInboundSms({ from: phone, to: PRIMARY, body: " Start ", providerMessageId: "in-1" }, { resolveContact: async () => ctx, turn });
    assert.equal(reply.reply, "You're subscribed again. Reply STOP to opt out.");
    const outcome = await sendAgentSmsReply(reply, { from: phone, to: PRIMARY });
    assert.equal(outcome?.status, "sent");
    const [contact] = await db.query<{ opted_out: boolean }>("select opted_out from public.contacts where id = $1", [lead]);
    assert.equal(contact.opted_out, false);
    assert.equal((await sms(lead, { automated: true })).ok, true);
  });

  it("STOP over SMS opts out and confirms; 'cancel appointment' and 'end appointment' don't", async () => {
    const lead = await newLead();
    const ctx = (): ContactContext => ({
      phone: "+15550001111",
      accountId: tenant,
      contactId: lead,
      leadStatus: "New",
      readyToBook: false,
      apptBooked: false,
      handoff: false,
      optedOut: false,
    });
    const turnsRun: string[] = [];
    const turn: InboundTurnDeps = {
      claim: claimInboundMessage,
      // Ordinary messages would reach the model; record that instead of calling it.
      runAgent: async (params): Promise<InboundAgentResult> => {
        if (/appointment/.test(params.body)) {
          turnsRun.push(params.body);
          return { reply: "", playbook: "none", contactId: lead, optedOut: false };
        }
        return runInboundAgent(params);
      },
      dispatchSoon: () => {},
    };
    for (const body of ["cancel appointment", "End appointment"]) {
      await handleInboundSms({ from: "+15550001111", to: PRIMARY, body, providerMessageId: randomUUID() }, { resolveContact: async () => ctx(), turn });
    }
    assert.deepEqual(turnsRun, ["cancel appointment", "End appointment"]);
    assert.equal((await db.query<{ opted_out: boolean }>("select opted_out from public.contacts where id = $1", [lead]))[0].opted_out, false);

    const reply = await handleInboundSms({ from: "+15550001111", to: PRIMARY, body: "STOP", providerMessageId: randomUUID() }, { resolveContact: async () => ctx(), turn });
    assert.equal(reply.reply, "You have been unsubscribed.");
    assert.equal((await db.query<{ opted_out: boolean }>("select opted_out from public.contacts where id = $1", [lead]))[0].opted_out, true);
  });
});

// ---------- Email unsubscribe ----------

describe("automated email unsubscribe", () => {
  beforeEach(seedAgentProfile);

  async function tokenFor(contactId: string, tenantId = tenant) {
    const link = automatedEmailUnsubscribe(tenantId, contactId);
    assert.ok(link);
    return new URL(link.url).searchParams.get("token")!;
  }

  it("journey email carries a footer link and one-click List-Unsubscribe headers", async () => {
    const lead = await newLead();
    await executor.execute(EMAIL_STEP, await inputFor(lead));
    const [call] = providers.resend.calls;
    assert.ok(call.html.startsWith("<p>Hello</p>"), call.html);
    const link = /href="([^"]+)"/.exec(call.html)?.[1];
    assert.ok(link?.includes("/api/email/unsubscribe?token="));
    assert.deepEqual(call.headers, { "List-Unsubscribe": `<${link}>`, "List-Unsubscribe-Post": "List-Unsubscribe=One-Click" });
  });

  it("the link unsubscribes once (repeat clicks keep the first time), logs it, and stops journey email", async () => {
    const lead = await newLead();
    const token = await tokenFor(lead);
    assert.equal(await unsubscribeFromAutomatedEmail(token), "unsubscribed");
    const [{ email_unsubscribed_at: first }] = await db.query<{ email_unsubscribed_at: Date }>("select email_unsubscribed_at from public.contacts where id = $1", [lead]);
    assert.ok(first);
    assert.equal(await unsubscribeFromAutomatedEmail(token), "unsubscribed");
    const [{ email_unsubscribed_at: second }] = await db.query<{ email_unsubscribed_at: Date }>("select email_unsubscribed_at from public.contacts where id = $1", [lead]);
    assert.equal(second.getTime(), first.getTime());
    const activities = await db.query<{ title: string }>("select title from public.contact_activities where contact_id = $1", [lead]);
    assert.deepEqual(activities.map((row) => row.title), ["Unsubscribed from automated email"]);

    const result = await executor.execute(EMAIL_STEP, await inputFor(lead));
    assert.equal(result.status, "skipped");
    assert.equal(result.status === "skipped" && result.reason, "unsubscribed");
    assert.equal(providers.resend.calls.length, 0);
  });

  async function withEnv<T>(overrides: Record<string, string | undefined>, work: () => Promise<T>): Promise<T> {
    const env = process.env as Record<string, string | undefined>;
    const previous = Object.fromEntries(Object.keys(overrides).map((name) => [name, env[name]]));
    const apply = (values: Record<string, string | undefined>) => {
      for (const [name, value] of Object.entries(values)) {
        if (value === undefined) delete env[name];
        else env[name] = value;
      }
    };
    apply(overrides);
    try {
      return await work();
    } finally {
      apply(previous);
    }
  }

  const PRODUCTION = { NODE_ENV: "production", NEXT_PUBLIC_SITE_URL: "https://app.reos.test" };

  it("production without EMAIL_UNSUBSCRIBE_SECRET can't make links: journey email is a config error and nothing is sent", async () => {
    const lead = await newLead();
    await withEnv({ ...PRODUCTION, EMAIL_UNSUBSCRIBE_SECRET: undefined, PLATFORM_SECRETS_ENCRYPTION_KEY: "platform-key" }, async () => {
      assert.equal(automatedEmailUnsubscribe(tenant, lead), null);
      await rejectsWith(executor.execute(EMAIL_STEP, await inputFor(lead)), "config", /Unsubscribe links can't be created/);
    });
    assert.equal(providers.resend.calls.length, 0);
  });

  it("production without EMAIL_UNSUBSCRIBE_SECRET accepts no token (a config error; nothing changes)", async () => {
    const lead = await newLead();
    const devToken = await tokenFor(lead);
    const result = await withEnv({ ...PRODUCTION, EMAIL_UNSUBSCRIBE_SECRET: undefined, PLATFORM_SECRETS_ENCRYPTION_KEY: "platform-key" }, async () => [
      await unsubscribeFromAutomatedEmail(devToken),
      await unsubscribeFromAutomatedEmail(signUnsubscribeToken("platform-key", tenant, lead)),
      await unsubscribeFromAutomatedEmail(signUnsubscribeToken("service_role", tenant, lead)),
    ]);
    assert.deepEqual(result, ["error", "error", "error"]);
    const [{ email_unsubscribed_at }] = await db.query<{ email_unsubscribed_at: Date | null }>("select email_unsubscribed_at from public.contacts where id = $1", [lead]);
    assert.equal(email_unsubscribed_at, null);
  });

  it("production with EMAIL_UNSUBSCRIBE_SECRET signs and accepts only its own tokens", async () => {
    const lead = await newLead();
    const devToken = await tokenFor(lead);
    await withEnv({ ...PRODUCTION, EMAIL_UNSUBSCRIBE_SECRET: "prod-unsubscribe-secret" }, async () => {
      const link = automatedEmailUnsubscribe(tenant, lead);
      assert.ok(link?.url.startsWith("https://app.reos.test/api/email/unsubscribe?token="));
      assert.equal(await unsubscribeFromAutomatedEmail(devToken), "invalid", "a token from the fallback secret");
      assert.equal(await unsubscribeFromAutomatedEmail(new URL(link!.url).searchParams.get("token")!), "unsubscribed");
    });
  });

  it("an email unsubscribe doesn't affect texts or DMs", async () => {
    const lead = await newLead();
    assert.equal(await unsubscribeFromAutomatedEmail(await tokenFor(lead)), "unsubscribed");
    assert.equal((await sms(lead, { automated: true })).ok, true);
  });

  it("invalid or tampered tokens change nothing", async () => {
    const lead = await newLead();
    const token = await tokenFor(lead);
    for (const bad of ["", "garbage", `${token}x`, `${randomUUID()}.${token.split(".")[1]}`]) {
      assert.equal(await unsubscribeFromAutomatedEmail(bad), "invalid", bad);
    }
    const [{ email_unsubscribed_at }] = await db.query<{ email_unsubscribed_at: Date | null }>("select email_unsubscribed_at from public.contacts where id = $1", [lead]);
    assert.equal(email_unsubscribed_at, null);
  });

  it("(fault 5) a failed contact lookup reports an error and records nothing (never a false success)", async () => {
    const lead = await newLead();
    const token = await tokenFor(lead);
    assert.equal(await withoutPrivilege("contacts", "select", () => unsubscribeFromAutomatedEmail(token)), "error");
    assert.equal(await withoutPrivilege("contacts", "update", () => unsubscribeFromAutomatedEmail(token)), "error");
    const [{ email_unsubscribed_at }] = await db.query<{ email_unsubscribed_at: Date | null }>("select email_unsubscribed_at from public.contacts where id = $1", [lead]);
    assert.equal(email_unsubscribed_at, null);
  });

  it("without a way to build the link (production without a public site URL), journey email is a config error and nothing is sent", async () => {
    const lead = await newLead();
    await withEnv({ NODE_ENV: "production", NEXT_PUBLIC_SITE_URL: undefined, EMAIL_UNSUBSCRIBE_SECRET: "prod-unsubscribe-secret" }, async () => {
      await rejectsWith(executor.execute(EMAIL_STEP, await inputFor(lead)), "config", /Unsubscribe links can't be created/);
    });
    assert.equal(providers.resend.calls.length, 0);
  });

  it("an unsubscribe also stops team email: to or cc, any letter case, linked contact or recipient address", async () => {
    const lead = await newLead();
    const check = (contactId: string | null, emails: string[]) => manualEmailUnsubscribeBlock(service, { tenantId: tenant, contactId, emails });
    assert.deepEqual(await check(lead, ["ana@example.com"]), { blocked: false });
    assert.equal(await unsubscribeFromAutomatedEmail(await tokenFor(lead)), "unsubscribed");
    assert.equal((await check(lead, ["someone@else.test"])).blocked, true, "linked contact");
    assert.equal((await check(null, ["ANA@Example.com"])).blocked, true, "recipient address");
    assert.equal((await check(null, ["boss@agency.test", "ana@example.com"])).blocked, true, "cc");
    assert.deepEqual(await check(null, ["boss@agency.test"]), { blocked: false });
  });

  it("the team-email check is per tenant and matches whole addresses only", async () => {
    const other = await newTenant();
    const theirs = await newLead({ tenantId: other });
    await db.query("update public.contacts set email = 'a_b@example.com', email_unsubscribed_at = now() where id = $1", [theirs]);
    const check = (tenantId: string, emails: string[]) => manualEmailUnsubscribeBlock(service, { tenantId, contactId: null, emails });
    assert.deepEqual(await check(tenant, ["a_b@example.com"]), { blocked: false }, "another tenant's unsubscribe");
    assert.equal((await check(other, ["a_b@example.com"])).blocked, true);
    assert.deepEqual(await check(other, ["axb@example.com"]), { blocked: false }, "_ is not a wildcard");
  });

  it("a failed team-email check blocks the email", async () => {
    const lead = await newLead();
    const result = await withoutPrivilege("contacts", "select", () =>
      manualEmailUnsubscribeBlock(service, { tenantId: tenant, contactId: lead, emails: ["ana@example.com"] }),
    );
    assert.deepEqual(result, { blocked: true, error: "Couldn't check email unsubscribes, so the email wasn't sent." });
    const byAddress = await withoutPrivilege("contacts", "select", () =>
      manualEmailUnsubscribeBlock(service, { tenantId: tenant, contactId: null, emails: ["ana@example.com"] }),
    );
    assert.equal(byAddress.blocked, true);
  });
});

// ---------- AI replies ----------

describe("AI replies: generate → store pending → send → record the outcome", () => {
  /** The agent loop's persistence: the reply is stored (pending) through the live backend before any send. */
  async function storeReply(contactId: string, channel: string, body: string) {
    const id = await liveBackend(tenant).appendMessage({ threadKey: "thread", contactId, channel, direction: "outbound", body, playbook: "concierge" });
    assert.ok(id);
    return id;
  }

  it("(fault 7) the stored reply is pending until the provider answers, and never in the AI's history while pending", async () => {
    const lead = await newLead();
    await storeReply(lead, "sms", "Happy to help!");
    const [row] = await outbound();
    assert.equal(row.send_status, "pending");
    assert.equal(row.body, "Happy to help!");
    assert.deepEqual(await getRecentMessages(lead), []);
  });

  it("SMS reply accepted: sent with Telnyx's id, and in history", async () => {
    const lead = await newLead();
    const replyMessageId = await storeReply(lead, "sms", "Happy to help!");
    const outcome = await sendAgentSmsReply({ reply: "Happy to help!", playbook: "concierge", tenantId: tenant, replyMessageId }, { from: "+15550001111", to: PRIMARY });
    assert.deepEqual(outcome, { status: "sent", providerMessageId: "telnyx-msg-1" });
    const [row] = await outbound();
    assert.equal(row.send_status, "sent");
    assert.equal(row.provider_message_id, "telnyx-msg-1");
    assert.deepEqual((await getRecentMessages(lead)).map((m) => m.content), ["Happy to help!"]);
  });

  it("SMS reply rejected: failed, the generated text kept, and left out of history", async () => {
    const lead = await newLead();
    const replyMessageId = await storeReply(lead, "sms", "Happy to help!");
    providers.telnyx.respondNext(422, { errors: [{ detail: "Blocked" }] });
    const outcome = await sendAgentSmsReply({ reply: "Happy to help!", playbook: "concierge", tenantId: tenant, replyMessageId }, { from: "+15550001111", to: PRIMARY });
    assert.equal(outcome?.status, "failed");
    const [row] = await outbound();
    assert.equal(row.send_status, "failed");
    assert.equal(row.body, "Happy to help!");
    assert.deepEqual(await getRecentMessages(lead), []);
  });

  it("SMS reply timed out: unknown (kept in history, since it may have been said); no number to reply from: failed", async () => {
    const lead = await newLead();
    const first = await storeReply(lead, "sms", "One");
    providers.telnyx.throwNext(timeout());
    assert.equal((await sendAgentSmsReply({ reply: "One", playbook: "concierge", tenantId: tenant, replyMessageId: first }, { from: "+15550001111", to: PRIMARY }))?.status, "unknown");
    const second = await storeReply(lead, "sms", "Two");
    assert.equal((await sendAgentSmsReply({ reply: "Two", playbook: "concierge", tenantId: tenant, replyMessageId: second }, { from: "+15550001111" }))?.status, "failed");
    assert.deepEqual((await outbound()).map((row) => row.send_status), ["unknown", "failed"]);
    assert.deepEqual((await getRecentMessages(lead)).map((m) => m.content), ["One"]);
    assert.equal(providers.telnyx.calls.length, 1);
  });

  it("an agent reply's outcome uses the real sender: a thrown sender is unknown, not lost", async () => {
    const lead = await newLead();
    const replyMessageId = await storeReply(lead, "sms", "Hi");
    const outcome = await sendAgentSmsReply(
      { reply: "Hi", playbook: "concierge", tenantId: tenant, replyMessageId },
      { from: "+15550001111", to: PRIMARY },
      { sendSms: async () => { throw new TypeError("fetch failed"); }, recordOutcome: recordReplyOutcome },
    );
    assert.equal(outcome?.status, "unknown");
    assert.equal((await outbound())[0].send_status, "unknown");
    assert.equal(typeof sendSmsMessage, "function");
  });

  function metaTurn(lead: string, sendBehavior: "ok" | "reject" | "throw") {
    const agentCalls: string[] = [];
    const turn: InboundTurnDeps = {
      claim: claimInboundMessage,
      runAgent: async (params): Promise<InboundAgentResult> => {
        agentCalls.push(params.body);
        const reply = `Reply to: ${params.body}`;
        const replyMessageId = await storeReply(lead, "messenger", reply);
        return { reply, playbook: "concierge", contactId: lead, optedOut: false, replyMessageId };
      },
      dispatchSoon: () => {},
    };
    const ctx: ContactContext = {
      phone: `psid-${lead}`,
      accountId: tenant,
      contactId: lead,
      leadStatus: "New",
      readyToBook: false,
      apptBooked: false,
      handoff: false,
      optedOut: false,
    };
    const handle = (mid: string) =>
      handleInboundMetaMessage(
        { channel: "messenger", pageOrAccountId: "page-1", contactExternalId: `psid-${lead}`, direction: "inbound", text: "Is it open?", mid },
        {
          resolveTenantId: async () => tenant,
          loadPageToken: async () => "page-token",
          fetchProfile: async () => null,
          resolveContact: async () => ctx,
          sendText: async () => {
            if (sendBehavior === "throw") throw timeout();
            if (sendBehavior === "reject") return { ok: false, outcome: "rejected", error: "(#551) This person isn't available" };
            return { ok: true, messageId: "m_reply_1" };
          },
          recordOutcome: recordReplyOutcome,
          turn,
        },
      );
    return { handle, agentCalls };
  }

  it("Meta DM reply: accepted → sent with the mid; rejected → failed with Meta's reason", async () => {
    const lead = await newLead();
    assert.equal((await metaTurn(lead, "ok").handle("mid-1")).sent, true);
    assert.equal((await metaTurn(lead, "reject").handle("mid-2")).sent, false);
    assert.deepEqual(
      (await outbound()).map((row) => [row.send_status, row.provider_message_id, row.send_error]),
      [["sent", "m_reply_1", null], ["failed", null, "(#551) This person isn't available"]],
    );
  });

  it("a restarted AI turn (the provider redelivers after the reply send timed out) runs no second turn and sends nothing more", async () => {
    const lead = await newLead();
    const first = metaTurn(lead, "throw");
    assert.equal((await first.handle("mid-9")).sent, false);
    const redelivery = metaTurn(lead, "ok");
    assert.equal((await redelivery.handle("mid-9")).skipped, "duplicate");
    assert.deepEqual(redelivery.agentCalls, []);
    const rows = await outbound();
    assert.equal(rows.length, 1);
    assert.equal(rows[0].send_status, "unknown");
    assert.equal(rows[0].body, "Reply to: Is it open?");
  });

  it("a Page echo of a reply REOS stored is not stored twice; an echo matching only a rejected send is stored", async () => {
    const lead = await newLead();
    const echo = (text: string) =>
      handleInboundMetaMessage(
        { channel: "messenger", pageOrAccountId: "page-1", contactExternalId: `psid-${lead}`, direction: "outbound", text, mid: null },
        {
          resolveTenantId: async () => tenant,
          loadPageToken: async () => "page-token",
          fetchProfile: async () => null,
          resolveContact: async () => ({ phone: `psid-${lead}`, accountId: tenant, contactId: lead, leadStatus: "New", readyToBook: false, apptBooked: false, handoff: false, optedOut: false }),
          sendText: async () => ({ ok: true, messageId: null }),
          recordOutcome: recordReplyOutcome,
        },
      );
    await metaTurn(lead, "ok").handle("mid-a");
    assert.equal((await echo("Reply to: Is it open?")).skipped, "echo_duplicate");
    const rejected = await storeReply(lead, "messenger", "Rejected text");
    await recordReplyOutcome(tenant, rejected, { status: "failed", error: "no" });
    assert.equal((await echo("Rejected text")).skipped, undefined);
    assert.equal((await outbound()).length, 3);
  });
});

// ---------- Tenant isolation ----------

describe("tenant isolation", () => {
  it("the same idempotency key in two tenants names two different sends", async () => {
    const other = await newTenant();
    const mine = await newLead();
    const theirs = await newLead({ tenantId: other });
    const key = "journey:shared:a1";
    assert.equal((await sms(mine, { automated: true, idempotencyKey: key })).ok, true);
    const second = await sms(theirs, { automated: true, idempotencyKey: key, tenantId: other });
    assert.equal(second.ok && second.deduplicated, undefined);
    assert.equal(providers.telnyx.calls.length, 2);
  });

  it("the same provider id in two tenants is recorded on both", async () => {
    const other = await newTenant();
    const mine = await newLead();
    const theirs = await newLead({ tenantId: other });
    providers.telnyx.respondNext(200, { data: { id: "same-id" } });
    providers.telnyx.respondNext(200, { data: { id: "same-id" } });
    await sms(mine);
    await sms(theirs, { tenantId: other });
    assert.equal((await outbound())[0].provider_message_id, "same-id");
    assert.equal((await outbound(other))[0].provider_message_id, "same-id");
  });

  it("a send can't target another tenant's contact", async () => {
    const other = await newTenant();
    const theirs = await newLead({ tenantId: other });
    const result = await sms(theirs);
    assert.deepEqual(result, { ok: false, error: "Client not found.", kind: "config" });
    assert.equal(providers.telnyx.calls.length, 0);
  });

  it("an outcome can't be recorded on another tenant's message", async () => {
    const other = await newTenant();
    const theirs = await newLead({ tenantId: other });
    const attempt = await beginOutboundMessage({ tenantId: other, contactId: theirs, channel: "sms", body: "x" });
    assert.equal(attempt.status, "ready");
    const messageId = (attempt as { messageId: string }).messageId;
    assert.equal(await recordOutboundOutcome({ tenantId: tenant, messageId, outcome: { status: "sent", providerMessageId: "p" } }), false);
    assert.equal((await outbound(other))[0].send_status, "pending");
  });

  it("an unsubscribe token signed for another tenant doesn't unsubscribe the contact", async () => {
    const other = await newTenant();
    const lead = await newLead();
    const forged = signUnsubscribeToken("service_role", other, lead);
    assert.equal(await unsubscribeFromAutomatedEmail(forged), "invalid");
    const [{ email_unsubscribed_at }] = await db.query<{ email_unsubscribed_at: Date | null }>("select email_unsubscribed_at from public.contacts where id = $1", [lead]);
    assert.equal(email_unsubscribed_at, null);
  });
});
