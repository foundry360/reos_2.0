/**
 * Journey sends respect the contact's communication state at send time: an
 * opted-out contact gets no journey SMS, and a handed-off contact gets no
 * automated SMS, email, Messenger, or Instagram message. The step is skipped
 * (not failed), the run continues, and internal steps (tasks, notifications,
 * lead updates) still run.
 *
 * The real live executor and deliverMessageToContact run against PGlite with
 * recorded Telnyx/Resend/Meta fakes; the engine runs on MemoryJourneyStore,
 * whose loaded lead is deliberately left stale so a send can only see the
 * current state by reading the database. live-actions-test-env.ts must be the
 * first import; it fails closed on any other network access.
 */

import { attachTestDb, blockedRequests, LIVE_ACTIONS_SCHEMA, providers } from "./live-actions-test-env.ts";

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, afterEach, beforeEach, describe, it } from "node:test";
import type { JourneyAIExecutor } from "./ai.ts";
import type { ActionConfig } from "./contracts.ts";
import { dispatchJourneyEvent, resumeDueRuns, type ActionInput, type EngineDeps, type JourneyEvent } from "./engine.ts";
import type { JourneySnapshot, SnapshotNode } from "./graph.ts";
import { createTestDb } from "./lead-status-test-db.ts";
import { MemoryJourneyStore } from "./memory-store.ts";

const db = await createTestDb({ schema: LIVE_ACTIONS_SCHEMA });
attachTestDb(db);
const { createLiveActionExecutor } = await import("./live-actions.ts");
const { deliverMessageToContact } = await import("../../messaging/deliver-message.ts");
const { clearPlatformSecretCache } = await import("../../admin/platform-secrets.ts");

const service = db.client("service_role");
const executor = createLiveActionExecutor(service);
const AGENT = randomUUID();
const START = new Date("2026-10-06T12:00:00.000Z");

let tenant: string;
let clock: Date;
let store: MemoryJourneyStore;
let deps: EngineDeps;

const ai: JourneyAIExecutor = { execute: async () => ({ success: true, output: { score: 1 }, text: "" }) };

after(async () => {
  await db.pg.close();
});

beforeEach(async () => {
  await db.reset();
  providers.reset();
  clearPlatformSecretCache();
  [{ id: tenant }] = await db.query<{ id: string }>("insert into public.tenants default values returning id");
  clock = START;
  store = new MemoryJourneyStore(() => clock);
  deps = { store, actions: executor, ai, now: () => clock };
});

afterEach(() => {
  assert.deepEqual(blockedRequests, [], "no request may leave the test environment");
});

// ---------- Seed helpers (direct SQL, outside the code under test) ----------

/** A lead reachable on every channel, with an assigned agent who can send email. */
async function reachableLead(state: { opted_out?: boolean; handoff?: boolean } = {}) {
  const [{ id }] = await db.query<{ id: string }>(
    `insert into public.contacts (tenant_id, first_name, last_name, email, assigned_agent_id, opted_out, handoff)
     values ($1, 'Ana', 'Lima', 'ana@example.com', $2, $3, $4) returning id`,
    [tenant, AGENT, state.opted_out ?? false, state.handoff ?? false],
  );
  await db.query("insert into public.contact_identities (contact_id, channel, external_id) values ($1, 'sms', $2), ($1, 'messenger', $3), ($1, 'instagram', $4)", [
    id,
    `+1555${String(Math.floor(Math.random() * 1e7)).padStart(7, "0")}`,
    `psid-${id}`,
    `igsid-${id}`,
  ]);
  const [lead] = await db.query<Record<string, unknown>>("select * from public.contacts where id = $1", [id]);
  store.contacts.set(id, { tenantId: tenant, lead });
  return id;
}

async function seedWorkspace() {
  await db.query("insert into public.tenant_phone_numbers (tenant_id, phone_e164, is_primary) values ($1, '+15559990000', true)", [tenant]);
  for (const [channel, account] of [["messenger", "page-1"], ["instagram", "ig-1"]]) {
    await db.query(
      `insert into public.channel_accounts (tenant_id, channel, external_page_id, external_account_id, status, metadata)
       values ($1, $2, $3, $4, 'connected', $5)`,
      [tenant, channel, `page-${channel}`, account, JSON.stringify({ access_token: `token-${channel}` })],
    );
  }
  await db.query("insert into public.memberships (tenant_id, user_id, role) values ($1, $2, 'member')", [tenant, AGENT]);
  await db.query("insert into public.profiles (id, display_name, reply_to_email) values ($1, 'Jordan Agent', 'jordan@agency.test')", [AGENT]);
  db.authUsers.set(AGENT, { email: "jordan.login@agency.test" });
}

async function setContact(contactId: string, fields: { opted_out?: boolean; handoff?: boolean }) {
  for (const [column, value] of Object.entries(fields)) {
    await db.query(`update public.contacts set ${column} = $1 where id = $2`, [value, contactId]);
  }
}

function rows<T = Record<string, unknown>>(table: string): Promise<T[]> {
  return db.query<T>(`select * from public.${table}`);
}

function sends() {
  return {
    sms: providers.telnyx.calls.length,
    email: providers.resend.calls.length,
    meta: providers.meta.calls.length,
  };
}

// ---------- Journey helpers ----------

const SMS = { action: "send_sms", body: "Hi {{first_name}}" } as const;
const EMAIL = { action: "send_email", subject: "Hi {{first_name}}", body: "Hello" } as const;
const MESSENGER = { action: "send_messenger", body: "Hi {{first_name}}" } as const;
const INSTAGRAM = { action: "send_instagram", body: "Hi {{first_name}}" } as const;
const WAIT = { action: "wait", duration: 1, unit: "days" } as const;
const task = (title: string) => ({ action: "create_task", title, notes: "", dueInDays: null }) as const;

function action(id: string, name: string, config: ActionConfig): SnapshotNode {
  return { id, type: "action", name, description: "", config: config as unknown as Record<string, unknown> };
}

/** Trigger → the actions in order. Action node names are "Step 1", "Step 2", … (step keys step_1, step_2, …). */
function linear(event: string, actions: ActionConfig[], extra: SnapshotNode[] = [], extraLinks: JourneySnapshot["connections"] = []): JourneySnapshot {
  const nodes: SnapshotNode[] = [
    { id: "t", type: "trigger", name: "Trigger", description: "", config: { event, filters: [] } },
    ...actions.map((config, index) => action(`a${index + 1}`, `Step ${index + 1}`, config)),
    ...extra,
  ];
  const ids = nodes.slice(0, actions.length + 1).map((node) => node.id);
  return {
    nodes,
    connections: [
      ...ids.slice(1).map((id, index) => ({ id: `${ids[index]}-${id}`, sourceNodeId: ids[index], targetNodeId: id, sourceHandle: null, targetHandle: null })),
      ...extraLinks,
    ],
  };
}

function leadEvent(contactId: string, journeyId?: string): JourneyEvent {
  return { tenantId: tenant, type: "lead.created", sourceId: randomUUID(), contactId, entityType: "contact", entityId: contactId, journeyId, payload: {} };
}

function stepsOf(runId: string) {
  return store
    .stepsFor(runId)
    .filter((step) => step.nodeId !== "t")
    .map(({ nodeId, status, output }) => ({ nodeId, status, output }));
}

function onlyRun(journeyId: string) {
  const runs = [...store.runs.values()].filter((run) => run.journeyId === journeyId);
  assert.equal(runs.length, 1);
  return runs[0];
}

async function afterWait() {
  clock = new Date(START.getTime() + 2 * 24 * 60 * 60_000);
  await resumeDueRuns(deps);
}

// ---------- SMS opt-out ----------

describe("SMS opt-out at send time", () => {
  beforeEach(seedWorkspace);

  it("a contact who is not opted out is texted, as before", async () => {
    const lead = await reachableLead();
    store.saveJourney(tenant, "j", linear("lead.created", [SMS]));
    await dispatchJourneyEvent(deps, leadEvent(lead));
    const run = onlyRun("j");
    assert.equal(run.status, "completed");
    assert.equal(sends().sms, 1);
    assert.equal(stepsOf(run.id)[0].status, "completed");
    assert.ok(stepsOf(run.id)[0].output?.message_id);
  });

  it("an opted-out contact's SMS is skipped (opted_out), not failed or retried; the next step runs and the run completes", async () => {
    const lead = await reachableLead({ opted_out: true });
    store.saveJourney(tenant, "j", linear("lead.created", [SMS, task("Call Ana")]));
    await dispatchJourneyEvent(deps, leadEvent(lead));
    const run = onlyRun("j");
    assert.equal(run.status, "completed");
    assert.equal(run.error, null);
    assert.equal(sends().sms, 0);
    assert.equal((await rows("messages")).length, 0);
    assert.deepEqual(stepsOf(run.id), [
      { nodeId: "a1", status: "skipped", output: { sent: false, channel: "sms", skipped_reason: "opted_out" } },
      { nodeId: "a2", status: "completed", output: stepsOf(run.id)[1].output },
    ]);
    assert.equal(store.stepsFor(run.id).filter((step) => step.nodeId === "a1").length, 1, "one attempt, no retry");
    assert.equal((await rows("tasks")).length, 1);
  });

  it("opt-out stops automated SMS, Messenger, and Instagram; email has its own unsubscribe and still goes out", async () => {
    const lead = await reachableLead({ opted_out: true });
    store.saveJourney(tenant, "j", linear("lead.created", [SMS, EMAIL, MESSENGER, INSTAGRAM]));
    await dispatchJourneyEvent(deps, leadEvent(lead));
    const run = onlyRun("j");
    assert.equal(run.status, "completed");
    assert.deepEqual(sends(), { sms: 0, email: 1, meta: 0 });
    assert.deepEqual(
      stepsOf(run.id).map((step) => [step.status, step.output?.skipped_reason]),
      [["skipped", "opted_out"], ["completed", undefined], ["skipped", "opted_out"], ["skipped", "opted_out"]],
    );
  });

  it("opting out during a Wait stops the SMS after it, even though the run's loaded lead is stale", async () => {
    const lead = await reachableLead();
    store.saveJourney(tenant, "j", linear("lead.created", [WAIT, SMS, task("Follow up")]));
    await dispatchJourneyEvent(deps, leadEvent(lead));
    assert.equal(onlyRun("j").status, "waiting");
    await setContact(lead, { opted_out: true });
    assert.equal(store.contacts.get(lead)!.lead.opted_out, false, "the store's lead still says not opted out");
    await afterWait();
    const run = onlyRun("j");
    assert.equal(run.status, "completed");
    assert.equal(sends().sms, 0);
    assert.equal(stepsOf(run.id).find((step) => step.nodeId === "a2")!.output?.skipped_reason, "opted_out");
    assert.equal((await rows("tasks")).length, 1);
  });

  it("opting back in during a Wait lets the SMS go out", async () => {
    const lead = await reachableLead({ opted_out: true });
    store.saveJourney(tenant, "j", linear("lead.created", [WAIT, SMS]));
    await dispatchJourneyEvent(deps, leadEvent(lead));
    await setContact(lead, { opted_out: false });
    await afterWait();
    assert.equal(onlyRun("j").status, "completed");
    assert.equal(sends().sms, 1);
  });
});

// ---------- Handoff ----------

describe("handoff at send time", () => {
  beforeEach(seedWorkspace);

  it("suppresses automated SMS, email, Messenger, and Instagram (handoff), and the run completes", async () => {
    const lead = await reachableLead({ handoff: true });
    store.saveJourney(tenant, "j", linear("lead.created", [SMS, EMAIL, MESSENGER, INSTAGRAM]));
    await dispatchJourneyEvent(deps, leadEvent(lead));
    const run = onlyRun("j");
    assert.equal(run.status, "completed");
    assert.deepEqual(sends(), { sms: 0, email: 0, meta: 0 });
    assert.equal((await rows("messages")).length, 0);
    assert.equal((await rows("crm_emails")).length, 0);
    assert.deepEqual(
      stepsOf(run.id).map(({ status, output }) => [status, output?.channel, output?.skipped_reason]),
      [
        ["skipped", "sms", "handoff"],
        ["skipped", "email", "handoff"],
        ["skipped", "messenger", "handoff"],
        ["skipped", "instagram", "handoff"],
      ],
    );
  });

  it("internal steps still run: a task, a team notification, and a lead update after a suppressed message", async () => {
    const lead = await reachableLead({ handoff: true });
    store.saveJourney(
      tenant,
      "j",
      linear("lead.created", [
        SMS,
        task("Call Ana"),
        { action: "notify_team", recipients: "assigned_agent", title: "Ana needs a call", body: "" },
        { action: "update_lead", fields: { lead_status: "Working" } },
      ]),
    );
    await dispatchJourneyEvent(deps, leadEvent(lead));
    const run = onlyRun("j");
    assert.equal(run.status, "completed", run.error ?? "");
    assert.deepEqual(stepsOf(run.id).map((step) => step.status), ["skipped", "completed", "completed", "completed"]);
    assert.equal((await rows("tasks")).length, 1);
    assert.equal((await rows("user_notifications")).length, 1);
    const [{ lead_status }] = await db.query<{ lead_status: string }>("select lead_status from public.contacts where id = $1", [lead]);
    assert.equal(lead_status, "Working");
  });

  it("an AI step still runs after a suppressed message", async () => {
    const lead = await reachableLead({ handoff: true });
    const snapshot = linear("lead.created", [SMS]);
    snapshot.nodes.push({ id: "ai", type: "ai", name: "Score", description: "", config: { agent: "default", goal: "Score", instructions: "" } });
    snapshot.connections.push({ id: "a1-ai", sourceNodeId: "a1", targetNodeId: "ai", sourceHandle: null, targetHandle: null });
    store.saveJourney(tenant, "j", snapshot);
    await dispatchJourneyEvent(deps, leadEvent(lead));
    const run = onlyRun("j");
    assert.equal(run.status, "completed", run.error ?? "");
    assert.deepEqual(stepsOf(run.id).map((step) => [step.nodeId, step.status]), [["a1", "skipped"], ["ai", "completed"]]);
  });

  it("handoff during a Wait stops the email after it", async () => {
    const lead = await reachableLead();
    store.saveJourney(tenant, "j", linear("lead.created", [WAIT, EMAIL, task("Follow up")]));
    await dispatchJourneyEvent(deps, leadEvent(lead));
    await setContact(lead, { handoff: true });
    await afterWait();
    const run = onlyRun("j");
    assert.equal(run.status, "completed");
    assert.equal(sends().email, 0);
    assert.equal(stepsOf(run.id).find((step) => step.nodeId === "a2")!.output?.skipped_reason, "handoff");
    assert.equal((await rows("tasks")).length, 1);
  });

  it("a handed-off contact is emailed normally once handoff ends", async () => {
    const lead = await reachableLead({ handoff: true });
    store.saveJourney(tenant, "j", linear("lead.created", [WAIT, EMAIL]));
    await dispatchJourneyEvent(deps, leadEvent(lead));
    await setContact(lead, { handoff: false });
    await afterWait();
    assert.equal(sends().email, 1);
    assert.equal(stepsOf(onlyRun("j").id)[1].status, "completed");
  });

  it("a suppressed message isn't a delivery to a Condition: its output has no message id", async () => {
    const lead = await reachableLead({ handoff: true });
    const check: SnapshotNode = { id: "c", type: "condition", name: "Delivered?", description: "", config: { field: "steps.step_1.output.message_id", operator: "is_not_empty", value: null } };
    const snapshot = linear("lead.created", [SMS], [check, action("yes", "Yes", task("delivered")), action("no", "No", task("not delivered"))], [
      { id: "a1-c", sourceNodeId: "a1", targetNodeId: "c", sourceHandle: null, targetHandle: null },
      { id: "c-yes", sourceNodeId: "c", targetNodeId: "yes", sourceHandle: "yes", targetHandle: null },
      { id: "c-no", sourceNodeId: "c", targetNodeId: "no", sourceHandle: "no", targetHandle: null },
    ]);
    store.saveJourney(tenant, "j", snapshot);
    await dispatchJourneyEvent(deps, leadEvent(lead));
    assert.equal(onlyRun("j").status, "completed");
    assert.deepEqual((await rows<{ title: string }>("tasks")).map((row) => row.title), ["not delivered"]);
  });

  it("a child journey applies the rule to its own sends; the parent isn't cancelled and continues", async () => {
    const lead = await reachableLead({ handoff: true });
    store.saveJourney(tenant, "child", linear("journey.started", [SMS, task("child task")]));
    store.saveJourney(tenant, "parent", linear("lead.created", [{ action: "start_journey", journeyId: "child" }, task("parent task")]));
    await dispatchJourneyEvent(deps, leadEvent(lead, "parent"));
    const parent = onlyRun("parent");
    const child = onlyRun("child");
    assert.equal(parent.status, "completed");
    assert.equal(child.status, "completed");
    assert.equal(stepsOf(child.id)[0].output?.skipped_reason, "handoff");
    assert.deepEqual((await rows<{ title: string }>("tasks")).map((row) => row.title).sort(), ["child task", "parent task"]);
    assert.equal(sends().sms, 0);
  });
});

// ---------- Manual sends are unchanged ----------

describe("manual (non-journey) delivery", () => {
  beforeEach(seedWorkspace);

  it("a team member can still text a handed-off contact: only journey sends ask for the handoff check", async () => {
    const lead = await reachableLead({ handoff: true });
    const sent = await deliverMessageToContact(service, { tenantId: tenant, contactId: lead, channel: "sms", body: "Hi from Jordan" });
    assert.equal(sent.ok, true);
    assert.equal(sends().sms, 1);
  });

  it("manual SMS to an opted-out contact is still refused with the same error", async () => {
    const lead = await reachableLead({ opted_out: true });
    const sent = await deliverMessageToContact(service, { tenantId: tenant, contactId: lead, channel: "sms", body: "Hi" });
    assert.deepEqual(sent, { ok: false, error: "This contact has opted out of SMS.", kind: "config", suppressed: "opted_out" });
    assert.equal(sends().sms, 0);
  });
});

// ---------- Direct executor results ----------

describe("live executor results for suppressed sends", () => {
  beforeEach(seedWorkspace);

  async function inputFor(contactId: string): Promise<ActionInput> {
    return { tenantId: tenant, runId: randomUUID(), nodeId: "node", contactId, lead: store.contacts.get(contactId)!.lead, opportunity: null };
  }

  it("each channel returns skipped with its reason and sends nothing", async () => {
    const optedOut = await reachableLead({ opted_out: true });
    const handedOff = await reachableLead({ handoff: true });
    assert.deepEqual(await executor.execute(SMS, await inputFor(optedOut)), { status: "skipped", output: { sent: false, channel: "sms" }, reason: "opted_out" });
    for (const [config, channel] of [[SMS, "sms"], [EMAIL, "email"], [MESSENGER, "messenger"], [INSTAGRAM, "instagram"]] as const) {
      assert.deepEqual(await executor.execute(config, await inputFor(handedOff)), { status: "skipped", output: { sent: false, channel }, reason: "handoff" }, channel);
    }
    assert.deepEqual(sends(), { sms: 0, email: 0, meta: 0 });
  });

  it("opt-out wins over handoff for SMS (both forbid it; the reason names the SMS rule)", async () => {
    const both = await reachableLead({ opted_out: true, handoff: true });
    const result = await executor.execute(SMS, await inputFor(both));
    assert.equal(result.status === "skipped" && result.reason, "opted_out");
  });
});
