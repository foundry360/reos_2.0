/**
 * E.3c email delivery reconciliation: signed Resend events and the
 * reconciliation sweeper settle outbound crm_emails records, never resend,
 * never create an email, and never move a record backwards.
 *
 * - Every send is tagged reos_email_id = crm_emails.id; a signed event naming
 *   the exact record proves Resend accepted it (pending/unknown/failed → sent)
 *   and orders delivery_status by event time.
 * - Events are idempotent on the provider event id; the tenant comes from the
 *   local record, never the payload.
 * - The sweeper applies Resend's own record when the row has a Resend id,
 *   moves stale pending to unknown, and otherwise leaves unknown alone.
 *
 * The real webhook handler, migration 066 functions, sweeper, Journey executor,
 * compose and appointment senders run unmodified on PGlite behind the PostgREST
 * bridge; Resend is a recorded fake. live-actions-test-env.ts must be the first
 * import; it fails closed on any other network access.
 */

import {
  attachTestDb,
  blockedRequests,
  LIVE_ACTIONS_SCHEMA,
  providers,
  resendRecords,
  TEST_SUPABASE_URL,
} from "./live-actions-test-env.ts";

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, afterEach, beforeEach, describe, it } from "node:test";
import type { ActionInput } from "./engine.ts";
import { JourneyStepError } from "./engine.ts";
import { createTestDb } from "./lead-status-test-db.ts";
import { signResendWebhook } from "../../email/resend-webhook-signature.ts";

const db = await createTestDb({
  schema: `${LIVE_ACTIONS_SCHEMA}
alter table public.contact_activities
  add column if not exists ends_at timestamptz,
  add column if not exists source text,
  add column if not exists metadata jsonb;`,
});
attachTestDb(db);
const { createLiveActionExecutor } = await import("./live-actions.ts");
const { sendComposedEmail } = await import("../../email/compose-email.ts");
const { handleResendWebhook } = await import("../../email/email-provider-events.ts");
const { reconcileOutboundEmails, PENDING_NOT_RECORDED_ERROR } = await import("../../email/email-reconciliation.ts");
const { sendAppointmentInvites } = await import("../../calendar/appointment-invites.ts");
const { clearPlatformSecretCache } = await import("../../admin/platform-secrets.ts");

const service = db.client("service_role");
const executor = createLiveActionExecutor(service);
const SECRET = `whsec_${Buffer.from("e3c-test-webhook-signing-key-0123456789").toString("base64")}`;
const AGENT = randomUUID();
const USER = randomUUID();
const LEAD_EMAIL = "ana@example.com";
const EMAIL_STEP = { action: "send_email", subject: "Hi {{first_name}}", body: "Hello" } as const;
const T0 = Date.parse("2026-10-06T12:00:00.000Z");
const at = (minutes: number) => new Date(T0 + minutes * 60_000).toISOString();

let tenant: string;

/** One-shot hooks: before a Resend request reaches the fake, and before a PATCH to crm_emails reaches the database. */
let atResend: (() => Promise<void>) | null = null;
let atEmailUpdate: (() => Promise<void>) | null = null;
const environmentFetch = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  const request = new Request(input, init);
  if (atResend && request.url.startsWith("https://api.resend.com/")) {
    const hook = atResend;
    atResend = null;
    await hook();
  }
  if (atEmailUpdate && request.method === "PATCH" && request.url.startsWith(`${TEST_SUPABASE_URL}/rest/v1/crm_emails`)) {
    const hook = atEmailUpdate;
    atEmailUpdate = null;
    await hook();
  }
  return environmentFetch(input, init);
};

after(async () => {
  globalThis.fetch = environmentFetch;
  await db.pg.close();
});

beforeEach(async () => {
  await db.reset();
  providers.reset();
  clearPlatformSecretCache();
  atResend = null;
  atEmailUpdate = null;
  tenant = await newTenant();
});

afterEach(() => {
  assert.deepEqual(blockedRequests, [], "no request may leave the test environment");
});

// ---------- Seed and read helpers (direct SQL, outside the code under test) ----------

async function newTenant(): Promise<string> {
  const [{ id }] = await db.query<{ id: string }>("insert into public.tenants default values returning id");
  await db.query("insert into public.memberships (tenant_id, user_id, role) values ($1, $2, 'member')", [id, AGENT]);
  await db.query(
    "insert into public.profiles (id, display_name, reply_to_email) values ($1, 'Jordan Agent', 'jordan@agency.test') on conflict do nothing",
    [AGENT],
  );
  db.authUsers.set(AGENT, { email: "jordan.login@agency.test" });
  return id;
}

async function newLead(tenantId = tenant): Promise<string> {
  const [{ id }] = await db.query<{ id: string }>(
    `insert into public.contacts (tenant_id, first_name, last_name, email, assigned_agent_id)
     values ($1, 'Ana', 'Lima', $2, $3) returning id`,
    [tenantId, LEAD_EMAIL, AGENT],
  );
  return id;
}

/** An outbound email record as an earlier send left it. */
async function seedEmail(fields: {
  status: string;
  providerMessageId?: string | null;
  contactId?: string | null;
  purpose?: string;
  tenantId?: string;
  createdAt?: string;
}): Promise<string> {
  const [{ id }] = await db.query<{ id: string }>(
    `insert into public.crm_emails (tenant_id, contact_id, provider, provider_message_id, thread_id, direction, from_email,
       to_recipients, subject, snippet, status, idempotency_key, metadata, created_at)
     values ($1, $2, 'resend', $3, 'thread-seed', 'outbound', 'journeys@reos.test', $4, 'Seeded email', 'Seeded body', $5, $6, $7, $8)
     returning id`,
    [
      fields.tenantId ?? tenant,
      fields.contactId ?? null,
      fields.providerMessageId ?? null,
      JSON.stringify([{ email: LEAD_EMAIL, name: null }]),
      fields.status,
      `seed:${randomUUID()}`,
      JSON.stringify({ purpose: fields.purpose ?? "marketing" }),
      fields.createdAt ?? new Date().toISOString(),
    ],
  );
  return id;
}

/** The sweeper's 15-minute threshold has passed for this record. */
async function makeDue(id: string) {
  await db.query("update public.crm_emails set reconcile_after = now() - interval '1 second' where id = $1", [id]);
}

interface EmailRow {
  id: string;
  tenant_id: string;
  status: string;
  provider_message_id: string | null;
  send_error: string | null;
  sent_at: Date | null;
  delivery_status: string | null;
  delivery_event_at: Date | null;
  reconcile_after: Date | null;
  reconcile_attempts: number;
  idempotency_key: string | null;
}

async function email(id: string): Promise<EmailRow> {
  const [row] = await db.query<EmailRow>("select * from public.crm_emails where id = $1", [id]);
  assert.ok(row, "the email record exists");
  return row;
}

async function emailCount(): Promise<number> {
  const [{ count }] = await db.query<{ count: number }>("select count(*)::int as count from public.crm_emails");
  return count;
}

async function onlyEmail(): Promise<EmailRow> {
  const rows = await db.query<EmailRow>("select * from public.crm_emails");
  assert.equal(rows.length, 1, "exactly one email record");
  return rows[0];
}

async function sentActivities(contactId: string): Promise<number> {
  const [{ count }] = await db.query<{ count: number }>(
    "select count(*)::int as count from public.contact_activities where contact_id = $1 and title like 'Email sent:%'",
    [contactId],
  );
  return count;
}

interface EventRow {
  provider_event_id: string;
  provider_message_id: string | null;
  event_type: string;
  result: string | null;
  tenant_id: string | null;
  email_id: string | null;
  processed_at: Date | null;
  detail: Record<string, unknown>;
}

function events(): Promise<EventRow[]> {
  return db.query<EventRow>("select * from public.email_provider_events order by received_at, provider_event_id");
}

let eventSequence = 0;

/** A Resend webhook delivery, signed with the test secret unless told otherwise. */
async function deliver(
  type: string,
  fields: {
    reosEmailId?: string | null;
    providerMessageId?: string | null;
    at?: string;
    eventId?: string;
    data?: Record<string, unknown>;
  },
  options: { signWith?: string; tamper?: boolean; secret?: string | null; omitSignature?: boolean } = {},
) {
  const eventId = fields.eventId ?? `msg_${++eventSequence}`;
  const body = JSON.stringify({
    type,
    created_at: fields.at ?? new Date().toISOString(),
    data: {
      email_id: fields.providerMessageId ?? null,
      created_at: at(0),
      from: "REOS Test <journeys@reos.test>",
      to: [LEAD_EMAIL],
      subject: "Hi Ana",
      tags: fields.reosEmailId ? { reos_email_id: fields.reosEmailId } : {},
      ...fields.data,
    },
  });
  const timestamp = String(Math.floor(Date.now() / 1000));
  const headers = new Headers({ "svix-id": eventId, "svix-timestamp": timestamp });
  if (!options.omitSignature) {
    headers.set("svix-signature", `v1,${signResendWebhook(options.signWith ?? SECRET, eventId, timestamp, body)}`);
  }
  return handleResendWebhook({
    secret: options.secret === undefined ? SECRET : options.secret,
    headers,
    rawBody: options.tamper ? body.replace("Hi Ana", "Hi Bob") : body,
  });
}

const OK = { status: 200, body: { received: true } };

async function inputFor(contactId: string, runId = randomUUID()): Promise<ActionInput> {
  const [lead] = await db.query<Record<string, unknown>>("select * from public.contacts where id = $1", [contactId]);
  return { tenantId: tenant, runId, nodeId: "a1", contactId, lead, opportunity: null };
}

async function withoutPrivilege<T>(table: string, privilege: "insert" | "update", work: () => Promise<T>): Promise<T> {
  await db.query(`revoke ${privilege} on public.${table} from service_role`);
  try {
    return await work();
  } finally {
    await db.query(`grant ${privilege} on public.${table} to service_role`);
  }
}

function compose(contactId: string, draftId: string, overrides: { subject?: string } = {}) {
  return sendComposedEmail(service, {
    tenantId: tenant,
    userId: USER,
    draftId,
    contactId,
    opportunityId: null,
    to: [{ email: LEAD_EMAIL, name: "Ana Lima" }],
    cc: [],
    subject: overrides.subject ?? "Following up",
    bodyHtml: "<p>Hi Ana</p>",
    threadId: null,
    replyTo: "jordan@agency.test",
    agentName: "Jordan Agent",
  });
}

const timeout = () => Object.assign(new Error("The operation was aborted due to timeout"), { name: "TimeoutError" });

// ---------- Webhook authentication ----------

describe("Resend webhook: only signed events are accepted", () => {
  it("rejects a bad signature, a changed body, a missing signature, and an unconfigured secret, changing nothing (5)", async () => {
    const lead = await newLead();
    const id = await seedEmail({ status: "pending", contactId: lead });
    const event = { reosEmailId: id, providerMessageId: "re_auth" };

    const otherSecret = `whsec_${Buffer.from("not-the-configured-secret-material").toString("base64")}`;
    assert.deepEqual(await deliver("email.sent", event, { signWith: otherSecret }), { status: 400, body: { error: "Invalid signature" } });
    assert.deepEqual(await deliver("email.sent", event, { tamper: true }), { status: 400, body: { error: "Invalid signature" } });
    assert.deepEqual(await deliver("email.sent", event, { omitSignature: true }), { status: 400, body: { error: "Invalid signature" } });
    assert.deepEqual(await deliver("email.sent", event, { secret: null }), { status: 503, body: { error: "Webhook not configured" } });

    assert.deepEqual(await events(), [], "no rejected event is recorded");
    assert.equal((await email(id)).status, "pending");
    assert.equal(await sentActivities(lead), 0);
  });
});

// ---------- Webhook: settling the exact email ----------

describe("Resend webhook: settling the exact email", () => {
  it("an accepted Journey email whose answer couldn't be saved is settled pending → sent by its signed event (1)", async () => {
    const lead = await newLead();
    const input = await inputFor(lead);
    await assert.rejects(
      withoutPrivilege("crm_emails", "update", () => executor.execute(EMAIL_STEP, input)),
      (error: unknown) => error instanceof JourneyStepError && error.kind === "config",
    );
    const pending = await onlyEmail();
    assert.equal(pending.status, "pending");
    assert.deepEqual(providers.resend.calls[0].tags, [{ name: "reos_email_id", value: pending.id }], "the send names its record");

    const response = await deliver("email.sent", { reosEmailId: pending.id, providerMessageId: "resend-email-1", at: at(1) });

    assert.deepEqual(response, OK, "the response carries no ids or tenant data");
    const settled = await email(pending.id);
    assert.equal(settled.status, "sent");
    assert.equal(settled.provider_message_id, "resend-email-1");
    assert.equal(settled.sent_at?.toISOString(), at(1));
    assert.equal(settled.send_error, null);
    assert.equal(settled.delivery_status, null, "email.sent is acceptance, not delivery");
    assert.equal(settled.reconcile_after, null, "a settled record leaves the sweeper");
    assert.equal(await sentActivities(lead), 1, "the Email sent activity is written once it's confirmed");
    assert.equal(providers.resend.calls.length, 1);
  });

  it("negative delivery events set delivery_status; email.failed on a pending record proves handoff and never invites a resend (2)", async () => {
    const lead = await newLead();
    await executor.execute(EMAIL_STEP, await inputFor(lead));
    const sent = await onlyEmail();
    assert.equal(sent.status, "sent");

    await deliver("email.bounced", {
      reosEmailId: sent.id,
      providerMessageId: sent.provider_message_id,
      at: at(5),
      data: { bounce: { type: "Permanent", subType: "General", message: "Mailbox does not exist" } },
    });
    const bounced = await email(sent.id);
    assert.deepEqual([bounced.status, bounced.delivery_status], ["sent", "bounced"]);
    const [bounceEvent] = await events();
    assert.deepEqual(bounceEvent.detail, { bounce_type: "Permanent", bounce_sub_type: "General" }, "only classifications are stored");

    const pendingLead = await newLead();
    const pendingInput = await inputFor(pendingLead);
    await assert.rejects(withoutPrivilege("crm_emails", "update", () => executor.execute(EMAIL_STEP, pendingInput)));
    const [pending] = await db.query<EmailRow>("select * from public.crm_emails where contact_id = $1", [pendingLead]);
    await deliver("email.failed", { reosEmailId: pending.id, providerMessageId: "resend-email-2", at: at(6), data: { failed: { reason: "reached_daily_quota" } } });
    const failed = await email(pending.id);
    assert.deepEqual([failed.status, failed.delivery_status], ["sent", "failed"]);

    const callsBefore = providers.resend.calls.length;
    const retry = await executor.execute(EMAIL_STEP, pendingInput);
    assert.equal(providers.resend.calls.length, callsBefore, "a delivery failure is never resent");
    assert.equal((retry.output as Record<string, unknown>).sent, true);
  });

  it("a redelivered event changes nothing, even after a newer event (3)", async () => {
    const id = await seedEmail({ status: "sent", providerMessageId: "re_dup" });
    const delivered = { reosEmailId: id, providerMessageId: "re_dup", at: at(1), eventId: "msg_delivered" };

    assert.deepEqual(await deliver("email.delivered", delivered), OK);
    assert.deepEqual(await deliver("email.delivered", delivered), OK);
    await deliver("email.complained", { reosEmailId: id, providerMessageId: "re_dup", at: at(2), eventId: "msg_complained" });
    assert.deepEqual(await deliver("email.delivered", delivered), OK);

    const row = await email(id);
    assert.equal(row.delivery_status, "complained");
    assert.equal(row.delivery_event_at?.toISOString(), at(2));
    const recorded = await events();
    assert.deepEqual(recorded.map((event) => [event.provider_event_id, event.result]), [
      ["msg_delivered", "applied"],
      ["msg_complained", "applied"],
    ]);
  });

  it("duplicate and follow-up events never write a second Email sent activity (4)", async () => {
    const lead = await newLead();
    const id = await seedEmail({ status: "pending", contactId: lead });
    const sent = { reosEmailId: id, providerMessageId: "re_once", at: at(1), eventId: "msg_sent" };

    await deliver("email.sent", sent);
    await deliver("email.sent", sent);
    await deliver("email.delivered", { reosEmailId: id, providerMessageId: "re_once", at: at(2) });
    await deliver("email.delivered", { reosEmailId: id, providerMessageId: "re_once", at: at(3) });

    assert.equal(await sentActivities(lead), 1);
    assert.equal((await email(id)).delivery_status, "delivered");
  });

  it("an event for no known email records an unmatched event and creates nothing (6)", async () => {
    const lead = await newLead();
    const id = await seedEmail({ status: "pending", contactId: lead });
    const before = await emailCount();

    assert.deepEqual(await deliver("email.delivered", { reosEmailId: randomUUID(), providerMessageId: "re_ghost_1" }), OK);
    assert.deepEqual(await deliver("email.delivered", { providerMessageId: "re_ghost_2" }), OK);
    assert.deepEqual(await deliver("email.sent", { reosEmailId: "not-a-uuid" }), OK);

    assert.equal(await emailCount(), before, "no email is fabricated");
    assert.equal((await email(id)).status, "pending");
    assert.equal(await sentActivities(lead), 0);
    for (const event of await events()) {
      assert.deepEqual([event.result, event.tenant_id, event.email_id], ["unmatched", null, null]);
    }
  });

  it("an event changes only the record it names; tenant comes from that record; ambiguity and mismatch change nothing (7)", async () => {
    const otherTenant = await newTenant();
    const otherLead = await newLead(otherTenant);
    const theirs = await seedEmail({ status: "unknown", providerMessageId: "re_same", tenantId: otherTenant, contactId: otherLead });
    const lead = await newLead();
    const ours = await seedEmail({ status: "unknown", providerMessageId: "re_same", contactId: lead });

    // No tag, and two tenants hold the provider id: ambiguous, so neither changes.
    await deliver("email.delivered", { providerMessageId: "re_same" });
    assert.equal((await email(theirs)).status, "unknown");
    assert.equal((await email(ours)).status, "unknown");

    // The payload's tenant claim is ignored; the tagged record's tenant is used.
    await deliver("email.sent", { reosEmailId: ours, providerMessageId: "re_same", data: { tenant_id: otherTenant } });
    assert.equal((await email(ours)).status, "sent");
    assert.equal((await email(theirs)).status, "unknown", "the other tenant's record is untouched");
    assert.equal(await sentActivities(otherLead), 0);
    const applied = (await events()).find((event) => event.result === "applied");
    assert.equal(applied?.tenant_id, tenant);

    // A tag naming a record whose Resend id differs is a mismatch, not evidence.
    const mismatched = await seedEmail({ status: "unknown", providerMessageId: "re_mine" });
    await deliver("email.sent", { reosEmailId: mismatched, providerMessageId: "re_someone_else" });
    assert.equal((await email(mismatched)).status, "unknown");
    assert.equal((await events()).at(-1)?.result, "mismatch");
  });

  it("an older or weaker event never regresses a sent, delivered email (8)", async () => {
    const id = await seedEmail({ status: "sent", providerMessageId: "re_order" });
    await db.query("update public.crm_emails set sent_at = $2 where id = $1", [id, at(0)]);
    await deliver("email.delivered", { reosEmailId: id, providerMessageId: "re_order", at: at(10) });

    await deliver("email.delivery_delayed", { reosEmailId: id, providerMessageId: "re_order", at: at(5) });
    await deliver("email.bounced", { reosEmailId: id, providerMessageId: "re_order", at: at(6) });
    await deliver("email.sent", { reosEmailId: id, providerMessageId: "re_order", at: at(1) });
    await deliver("email.delivery_delayed", { reosEmailId: id, providerMessageId: "re_order", at: at(20) });

    const row = await email(id);
    assert.equal(row.status, "sent");
    assert.equal(row.sent_at?.toISOString(), at(0));
    assert.equal(row.delivery_status, "delivered");
    assert.equal(row.delivery_event_at?.toISOString(), at(10));
    assert.deepEqual((await events()).slice(1).map((event) => event.result), ["stale", "stale", "stale", "stale"]);
  });

  it("tracking events are recorded but settle nothing", async () => {
    const id = await seedEmail({ status: "unknown" });
    await deliver("email.opened", { reosEmailId: id, providerMessageId: "re_open" });
    assert.equal((await email(id)).status, "unknown");
    assert.equal((await events())[0].result, "ignored");
  });
});

// ---------- Reconciliation sweeper ----------

describe("reconciliation sweeper", () => {
  it("moves a stale pending record to unknown, and leaves one still within the threshold (9)", async () => {
    const stale = await seedEmail({ status: "pending" });
    const fresh = await seedEmail({ status: "pending" });
    await makeDue(stale);

    const summary = await reconcileOutboundEmails();

    assert.equal(summary?.claimed, 1);
    assert.equal(summary?.markedUnknown, 1);
    const moved = await email(stale);
    assert.deepEqual([moved.status, moved.send_error], ["unknown", PENDING_NOT_RECORDED_ERROR]);
    assert.ok(moved.reconcile_after && moved.reconcile_after.getTime() > Date.now() + 14 * 60_000, "first unknown check in 15 minutes");
    assert.equal((await email(fresh)).status, "pending");
  });

  it("rechecks a stale unknown record on a backoff and retires it after 7 days (10)", async () => {
    const recent = await seedEmail({ status: "unknown" });
    const old = await seedEmail({ status: "unknown", createdAt: new Date(Date.now() - 8 * 86_400_000).toISOString() });
    await makeDue(recent);
    await makeDue(old);

    const summary = await reconcileOutboundEmails();

    assert.deepEqual([summary?.claimed, summary?.stillUnknown, summary?.retired], [2, 1, 1]);
    const rechecked = await email(recent);
    assert.equal(rechecked.status, "unknown");
    assert.equal(rechecked.reconcile_attempts, 1);
    const nextIn = (rechecked.reconcile_after?.getTime() ?? 0) - Date.now();
    assert.ok(nextIn > 59 * 60_000 && nextIn <= 60 * 60_000, "next check in an hour");
    const retired = await email(old);
    assert.deepEqual([retired.status, retired.reconcile_after], ["unknown", null]);
  });

  it("running twice changes nothing more (11)", async () => {
    const pending = await seedEmail({ status: "pending" });
    const unknown = await seedEmail({ status: "unknown" });
    await makeDue(pending);
    await makeDue(unknown);

    await reconcileOutboundEmails();
    const first = [await email(pending), await email(unknown)];
    const second = await reconcileOutboundEmails();

    assert.equal(second?.claimed, 0);
    assert.deepEqual([await email(pending), await email(unknown)], first);
  });

  it("never resends or creates an email, and a Journey retry still doesn't resend (12)", async () => {
    const lead = await newLead();
    const input = await inputFor(lead);
    providers.resend.throwNext(timeout());
    await assert.rejects(executor.execute(EMAIL_STEP, input));
    const unknown = await onlyEmail();
    assert.equal(unknown.status, "unknown");
    await makeDue(unknown.id);

    await reconcileOutboundEmails();
    await reconcileOutboundEmails();

    assert.equal(providers.resend.calls.length, 1, "only the original attempt reached Resend");
    assert.equal(await emailCount(), 1);
    assert.equal((await email(unknown.id)).status, "unknown");
    await assert.rejects(executor.execute(EMAIL_STEP, input), (error: unknown) => error instanceof JourneyStepError && error.kind === "config");
    assert.equal(providers.resend.calls.length, 1);
  });

  it("Resend's record of the exact email settles an unknown record (13)", async () => {
    const lead = await newLead();
    const id = await seedEmail({ status: "unknown", providerMessageId: "re_known", contactId: lead });
    resendRecords.set("re_known", { lastEvent: "delivered", tags: [{ name: "reos_email_id", value: id }] });
    await makeDue(id);

    const summary = await reconcileOutboundEmails();

    assert.equal(summary?.resolved, 1);
    const row = await email(id);
    assert.deepEqual([row.status, row.delivery_status, row.delivery_event_at], ["sent", "delivered", null]);
    assert.equal(await sentActivities(lead), 1);
    assert.deepEqual(providers.resendRetrieve.calls.map((call) => call.id), ["re_known"]);
    assert.equal(providers.resend.calls.length, 0);
  });

  it("without provider truth a record stays unknown: no id, not found, an error, or a tag naming another record (14)", async () => {
    const noId = await seedEmail({ status: "unknown" });
    const notFound = await seedEmail({ status: "unknown", providerMessageId: "re_missing" });
    const errored = await seedEmail({ status: "unknown", providerMessageId: "re_error" });
    const otherTag = await seedEmail({ status: "unknown", providerMessageId: "re_other" });
    resendRecords.set("re_error", { lastEvent: "delivered" });
    resendRecords.set("re_other", { lastEvent: "delivered", tags: [{ name: "reos_email_id", value: randomUUID() }] });
    for (const id of [noId, notFound, otherTag]) await makeDue(id);
    const first = await reconcileOutboundEmails();

    await makeDue(errored);
    providers.resendRetrieve.respondNext(500, { name: "internal_server_error" });
    const second = await reconcileOutboundEmails();

    assert.deepEqual([first?.resolved, first?.stillUnknown, second?.resolved, second?.stillUnknown], [0, 3, 0, 1]);
    for (const id of [noId, notFound, errored, otherTag]) assert.equal((await email(id)).status, "unknown");
    assert.deepEqual(
      providers.resendRetrieve.calls.map((call) => call.id).sort(),
      ["re_error", "re_missing", "re_other"],
      "no id means no lookup",
    );
    assert.equal(providers.resend.calls.length, 0);
  });
});

// ---------- Recovery and idempotency ----------

describe("recovery and existing idempotency", () => {
  it("a compose email accepted but not saved is recovered by its event without a resend; the draft then reads sent (17)", async () => {
    const lead = await newLead();
    const draft = randomUUID();
    const first = await withoutPrivilege("crm_emails", "update", () => compose(lead, draft));
    assert.equal(first.outcome, "not_confirmed");
    const pending = await onlyEmail();
    assert.equal(pending.status, "pending");

    await deliver("email.delivered", { reosEmailId: pending.id, providerMessageId: "resend-email-1", at: at(2) });
    const retry = await compose(lead, draft);

    assert.equal(retry.outcome, "sent");
    assert.equal(providers.resend.calls.length, 1, "never resent");
    const row = await email(pending.id);
    assert.deepEqual([row.status, row.provider_message_id, row.delivery_status], ["sent", "resend-email-1", "delivered"]);
    assert.equal(await sentActivities(lead), 1);
  });

  it("Journey idempotency holds, and an event that beats the send's own record leaves one activity (18)", async () => {
    const lead = await newLead();
    const input = await inputFor(lead);
    atResend = async () => {
      const [row] = await db.query<{ id: string }>("select id from public.crm_emails");
      await deliver("email.sent", { reosEmailId: row.id, providerMessageId: "resend-email-1", at: at(0) });
    };

    const result = await executor.execute(EMAIL_STEP, input);
    assert.equal((result.output as Record<string, unknown>).sent, true);
    assert.equal((result.output as Record<string, unknown>).provider_message_id, "resend-email-1");
    const again = await executor.execute(EMAIL_STEP, input);
    assert.equal((again.output as Record<string, unknown>).sent, true);

    assert.equal(providers.resend.calls.length, 1);
    assert.equal(providers.resend.calls[0].idempotencyKey, `journey:${input.runId}:a1`);
    const row = await onlyEmail();
    assert.deepEqual([row.status, row.provider_message_id], ["sent", "resend-email-1"]);
    assert.equal(await sentActivities(lead), 1, "the event wrote it; the send didn't write a second");
  });

  it("compose idempotency holds: one send per draft, a changed draft is a conflict, events add nothing (19)", async () => {
    const lead = await newLead();
    const draft = randomUUID();
    assert.equal((await compose(lead, draft)).outcome, "sent");
    const row = await onlyEmail();
    assert.deepEqual(providers.resend.calls[0].tags, [{ name: "reos_email_id", value: row.id }]);
    await deliver("email.sent", { reosEmailId: row.id, providerMessageId: row.provider_message_id, eventId: "msg_compose" });
    await deliver("email.sent", { reosEmailId: row.id, providerMessageId: row.provider_message_id, eventId: "msg_compose" });

    assert.equal((await compose(lead, draft)).outcome, "sent");
    assert.equal((await compose(lead, draft, { subject: "Changed" })).outcome, "draft_conflict");
    assert.equal(providers.resend.calls.length, 1);
    assert.equal(await sentActivities(lead), 1);
  });

  it("appointment email is tagged, settled by events without an Email sent activity, and never resent (20)", async () => {
    const lead = await newLead();
    const [{ id: appointment }] = await db.query<{ id: string }>(
      `insert into public.contact_activities (tenant_id, contact_id, activity_type, title, occurred_at, ends_at, source)
       values ($1, $2, 'appointment', 'Consult', $3, $4, 'manual') returning id`,
      [tenant, lead, at(60 * 48), at(60 * 48 + 30)],
    );
    providers.resend.throwNext(timeout());
    const invite = () =>
      sendAppointmentInvites({
        tenantId: tenant,
        appointmentId: appointment,
        summary: "Consult",
        label: "Thu, Oct 8 at 3:00 PM",
        start: new Date(at(60 * 48)),
        end: new Date(at(60 * 48 + 30)),
        lead: { email: LEAD_EMAIL, name: "Ana Lima" },
        agentUserId: null,
        organizerFallback: { email: "agent@broker.test", name: "Jordan Agent" },
      });

    const result = await invite();
    assert.equal(result.leadSent, false);
    const rows = await db.query<EmailRow & { metadata: Record<string, unknown> }>(
      "select * from public.crm_emails order by idempotency_key",
    );
    const leadRow = rows.find((row) => row.metadata.recipient_role === "lead");
    const agentRow = rows.find((row) => row.metadata.recipient_role === "agent");
    assert.ok(leadRow && agentRow);
    assert.equal(leadRow.status, "unknown");
    assert.deepEqual(
      providers.resend.calls.map((call) => call.tags),
      [[{ name: "reos_email_id", value: leadRow.id }], [{ name: "reos_email_id", value: agentRow.id }]],
    );
    assert.equal(providers.resend.calls[0].attachments.length, 1, "the calendar invite is still attached");

    await makeDue(leadRow.id);
    await reconcileOutboundEmails();
    assert.equal((await email(leadRow.id)).status, "unknown");
    await invite();
    assert.equal(providers.resend.calls.length, 2, "the unknown invite is never resent");

    await deliver("email.delivered", { reosEmailId: leadRow.id, providerMessageId: "re_invite", at: at(3) });
    await deliver("email.bounced", { reosEmailId: agentRow.id, providerMessageId: agentRow.provider_message_id, at: at(3) });
    const settledLead = await email(leadRow.id);
    assert.deepEqual([settledLead.status, settledLead.delivery_status], ["sent", "delivered"]);
    const bouncedAgent = await email(agentRow.id);
    assert.deepEqual([bouncedAgent.status, bouncedAgent.delivery_status], ["sent", "bounced"]);
    assert.equal(await sentActivities(lead), 0, "appointment email keeps its own history, without Email sent activities");
  });
});

// ---------- Concurrency ----------

describe("concurrency: database guards decide every race", () => {
  it("a webhook settling the record while the sweeper holds it wins; the sweeper never regresses it (15)", async () => {
    const lead = await newLead();
    const pending = await seedEmail({ status: "pending", contactId: lead });
    await makeDue(pending);
    atEmailUpdate = async () => {
      await deliver("email.sent", { reosEmailId: pending, providerMessageId: "re_race", at: at(1) });
    };
    const first = await reconcileOutboundEmails();
    assert.equal(first?.settledElsewhere, 1);
    assert.equal((await email(pending)).status, "sent");

    const unknown = await seedEmail({ status: "unknown", providerMessageId: "re_race_2", contactId: lead });
    resendRecords.set("re_race_2", { lastEvent: "delivered" });
    await makeDue(unknown);
    atResend = async () => {
      await deliver("email.sent", { reosEmailId: unknown, providerMessageId: "re_race_2", at: at(2) });
    };
    const second = await reconcileOutboundEmails();
    assert.equal(second?.resolved, 1, "the webhook made it sent; Resend's record only added its delivery");
    const row = await email(unknown);
    assert.deepEqual([row.status, row.delivery_status], ["sent", "delivered"], "Resend's record still adds delivery");

    const both = await seedEmail({ status: "pending", contactId: lead });
    await makeDue(both);
    await Promise.all([
      reconcileOutboundEmails(),
      deliver("email.sent", { reosEmailId: both, providerMessageId: "re_race_3", at: at(3) }),
    ]);
    assert.equal((await email(both)).status, "sent");
    assert.equal(await sentActivities(lead), 3, "one activity per email, never two");
  });

  it("concurrent sweepers never take the same record (16)", async () => {
    const lead = await newLead();
    for (let index = 0; index < 30; index += 1) {
      const id = await seedEmail({ status: "unknown", providerMessageId: `re_bulk_${index}`, contactId: lead });
      resendRecords.set(`re_bulk_${index}`, { lastEvent: "sent" });
      await makeDue(id);
    }

    const summaries = await Promise.all([
      reconcileOutboundEmails({ batchSize: 10 }),
      reconcileOutboundEmails({ batchSize: 10 }),
      reconcileOutboundEmails({ batchSize: 10 }),
    ]);

    assert.equal(summaries.reduce((total, summary) => total + (summary?.claimed ?? 0), 0), 30);
    assert.equal(providers.resendRetrieve.calls.length, 30, "each record looked up once");
    assert.equal(new Set(providers.resendRetrieve.calls.map((call) => call.id)).size, 30);
    assert.equal(await sentActivities(lead), 30);
    const [{ count }] = await db.query<{ count: number }>("select count(*)::int as count from public.crm_emails where status = 'sent'");
    assert.equal(count, 30);
  });

  it("concurrent webhooks for one email settle it once", async () => {
    const lead = await newLead();
    const id = await seedEmail({ status: "pending", contactId: lead });
    const results = await Promise.all([
      deliver("email.sent", { reosEmailId: id, providerMessageId: "re_many", at: at(1), eventId: "msg_a" }),
      deliver("email.sent", { reosEmailId: id, providerMessageId: "re_many", at: at(1), eventId: "msg_a" }),
      deliver("email.delivered", { reosEmailId: id, providerMessageId: "re_many", at: at(2), eventId: "msg_b" }),
      deliver("email.delivery_delayed", { reosEmailId: id, providerMessageId: "re_many", at: at(1), eventId: "msg_c" }),
    ]);
    assert.ok(results.every((result) => result.status === 200));
    assert.equal(await sentActivities(lead), 1);
    assert.equal((await email(id)).delivery_status, "delivered");
    assert.equal((await events()).length, 3);
  });

  it("concurrent reconciliation of one Resend record applies it once", async () => {
    const lead = await newLead();
    const id = await seedEmail({ status: "unknown", providerMessageId: "re_twice", contactId: lead });
    resendRecords.set("re_twice", { lastEvent: "bounced" });
    await makeDue(id);
    await Promise.all([reconcileOutboundEmails(), reconcileOutboundEmails()]);
    assert.equal(providers.resendRetrieve.calls.length, 1);
    assert.equal(await sentActivities(lead), 1);
    assert.deepEqual([(await email(id)).status, (await email(id)).delivery_status], ["sent", "bounced"]);
  });

  it("a failed email's retry racing its event is sent once with one activity", async () => {
    const lead = await newLead();
    const input = await inputFor(lead);
    providers.resend.respondNext(422, { name: "validation_error", message: "Invalid `to` field." });
    await assert.rejects(executor.execute(EMAIL_STEP, input), (error: unknown) => error instanceof JourneyStepError && error.kind === "transient");
    const failed = await onlyEmail();
    assert.equal(failed.status, "failed");

    atResend = async () => {
      await deliver("email.sent", { reosEmailId: failed.id, providerMessageId: "resend-email-2", at: at(4) });
      await deliver("email.delivery_delayed", { reosEmailId: failed.id, providerMessageId: "resend-email-2", at: at(3) });
    };
    const retry = await executor.execute(EMAIL_STEP, input);

    assert.equal((retry.output as Record<string, unknown>).sent, true);
    assert.equal(providers.resend.calls.length, 2);
    const row = await email(failed.id);
    assert.deepEqual([row.status, row.provider_message_id, row.delivery_status], ["sent", "resend-email-2", "delayed"]);
    assert.equal(await sentActivities(lead), 1);
    await executor.execute(EMAIL_STEP, input);
    assert.equal(providers.resend.calls.length, 2);
  });
});
