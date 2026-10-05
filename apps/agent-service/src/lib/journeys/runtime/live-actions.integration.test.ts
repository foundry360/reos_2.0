/**
 * The real Journey action executor: createLiveActionExecutor and every service
 * it calls run unmodified. Only the last hop is replaced: Supabase is PGlite
 * behind the PostgREST bridge, and Telnyx, Resend, and Meta are recorded fakes.
 * live-actions-test-env.ts must be the first import; it fails closed on any
 * other network access.
 */

import {
  attachTestDb,
  blockedRequests,
  LIVE_ACTIONS_SCHEMA,
  providers,
  TEST_FROM_EMAIL,
  TEST_KEYS,
  TEST_SUPABASE_URL,
} from "./live-actions-test-env.ts";

import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";
import { after, afterEach, beforeEach, describe, it } from "node:test";
import type { JourneyAIExecutor } from "./ai.ts";
import type { ActionConfig } from "./contracts.ts";
import { dispatchJourneyEvent, JourneyStepError, type ActionInput, type ActionResult } from "./engine.ts";
import type { JourneySnapshot } from "./graph.ts";
import { createTestDb } from "./lead-status-test-db.ts";
import { MemoryJourneyStore } from "./memory-store.ts";

const db = await createTestDb({ schema: LIVE_ACTIONS_SCHEMA });
attachTestDb(db);
const { createLiveActionExecutor } = await import("./live-actions.ts");
const { clearPlatformSecretCache } = await import("../../admin/platform-secrets.ts");

const service = db.client("service_role");
const executor = createLiveActionExecutor(service);

const AGENT = randomUUID();
const OTHER_AGENT = randomUUID();
const OUTSIDER = randomUUID();
const PRIMARY_NUMBER = "+15559990000";

let tenant: string;

after(async () => {
  await db.pg.close();
});

beforeEach(async () => {
  await db.reset();
  providers.reset();
  clearPlatformSecretCache();
  [{ id: tenant }] = await db.query<{ id: string }>("insert into public.tenants default values returning id");
});

afterEach(() => {
  assert.deepEqual(blockedRequests, [], "no request may leave the test environment");
});

// ---------- Seed helpers (direct SQL, outside the code under test) ----------

async function newLead(fields: { email?: string | null; assigned_agent_id?: string | null; lead_status?: string } = {}) {
  const [row] = await db.query<{ id: string }>(
    `insert into public.contacts (tenant_id, first_name, last_name, email, assigned_agent_id, lead_status)
     values ($1, 'Ana', 'Lima', $2, $3, $4) returning id`,
    [tenant, fields.email ?? null, fields.assigned_agent_id ?? null, fields.lead_status ?? "New"],
  );
  return row.id;
}

async function addIdentity(contactId: string, channel: string, externalId: string) {
  await db.query("insert into public.contact_identities (contact_id, channel, external_id) values ($1, $2, $3)", [
    contactId,
    channel,
    externalId,
  ]);
}

async function addPrimaryNumber() {
  await db.query("insert into public.tenant_phone_numbers (tenant_id, phone_e164, is_primary) values ($1, $2, true)", [
    tenant,
    PRIMARY_NUMBER,
  ]);
}

async function connectMeta(channel: "messenger" | "instagram", fields: { pageId: string; accountId: string; token: string }) {
  await db.query(
    `insert into public.channel_accounts (tenant_id, channel, external_page_id, external_account_id, status, metadata)
     values ($1, $2, $3, $4, 'connected', $5)`,
    [tenant, channel, fields.pageId, fields.accountId, JSON.stringify({ access_token: fields.token })],
  );
}

async function addMember(userId: string, role = "member") {
  await db.query("insert into public.memberships (tenant_id, user_id, role) values ($1, $2, $3)", [tenant, userId, role]);
}

async function newOpportunity(contactId: string, assignedAgentId: string | null = null) {
  const [row] = await db.query<{ id: string }>(
    "insert into public.opportunities (tenant_id, contact_id, assigned_agent_id) values ($1, $2, $3) returning id",
    [tenant, contactId, assignedAgentId],
  );
  return row.id;
}

/** What the engine passes an action: the run's lead (as loaded from the database) and opportunity. */
async function inputFor(contactId: string, opportunityId: string | null = null): Promise<ActionInput> {
  const [lead] = await db.query<Record<string, unknown>>("select * from public.contacts where id = $1", [contactId]);
  return {
    tenantId: tenant,
    runId: randomUUID(),
    nodeId: "node",
    contactId,
    lead,
    opportunity: opportunityId ? { id: opportunityId } : null,
  };
}

function rows<T = Record<string, unknown>>(table: string): Promise<T[]> {
  return db.query<T>(`select * from public.${table}`);
}

async function rejectsWith(promise: Promise<ActionResult>, kind: "config" | "transient", message: string | RegExp) {
  await assert.rejects(promise, (error: unknown) => {
    assert.ok(error instanceof JourneyStepError, `expected a JourneyStepError, got ${String(error)}`);
    assert.equal(error.kind, kind);
    if (typeof message === "string") assert.equal(error.message, message);
    else assert.match(error.message, message);
    return true;
  });
}

/** Runs `work` with `privilege` on `table` revoked from the service role, the way a failing write looks. */
async function withoutPrivilege<T>(table: string, privilege: "insert", work: () => Promise<T>): Promise<T> {
  await db.query(`revoke ${privilege} on public.${table} from service_role`);
  try {
    return await work();
  } finally {
    await db.query(`grant ${privilege} on public.${table} to service_role`);
  }
}

const execute = (action: Exclude<ActionConfig, { action: "wait" }>, input: ActionInput) => executor.execute(action, input);

// ---------- Safety ----------

describe("test environment", () => {
  it("points every client at the test database and refuses any other network access", async () => {
    assert.equal(process.env.NEXT_PUBLIC_SUPABASE_URL, TEST_SUPABASE_URL);
    assert.equal(process.env.SUPABASE_SERVICE_ROLE_KEY, "service_role");

    await assert.rejects(fetch("https://example.supabase.co/rest/v1/contacts"), /Blocked network request/);
    await assert.rejects(fetch("https://api.openai.com/v1/chat/completions", { method: "POST" }), /Blocked network request/);
    const http = createRequire(import.meta.url)("node:https") as { request: () => unknown };
    assert.throws(() => http.request(), /Blocked network request/);

    assert.deepEqual(blockedRequests, [
      "GET https://example.supabase.co/rest/v1/contacts",
      "POST https://api.openai.com/v1/chat/completions",
      "node:https.request",
    ]);
    blockedRequests.length = 0;
  });
});

// ---------- Send SMS ----------

describe("send_sms (live executor → deliverMessageToContact → Telnyx)", () => {
  const sms = { action: "send_sms", body: "  Hi {{first_name}}, this is REOS.  " } as const;

  it("texts the lead's number from the primary number and logs the message", async () => {
    const lead = await newLead();
    await addIdentity(lead, "sms", "555-010-2030");
    await addPrimaryNumber();

    const result = await execute(sms, await inputFor(lead));

    assert.deepEqual(
      providers.telnyx.calls.map(({ apiKey, from, to, text }) => ({ apiKey, from, to, text })),
      [{ apiKey: TEST_KEYS.telnyx, from: PRIMARY_NUMBER, to: "+15550102030", text: "Hi Ana, this is REOS." }],
    );
    const messages = await rows<{ id: string; tenant_id: string; contact_id: string; channel: string; direction: string; body: string }>("messages");
    assert.equal(messages.length, 1);
    assert.deepEqual(
      { tenant: messages[0].tenant_id, contact: messages[0].contact_id, channel: messages[0].channel, direction: messages[0].direction, body: messages[0].body },
      { tenant, contact: lead, channel: "sms", direction: "outbound", body: "Hi Ana, this is REOS." },
    );
    assert.deepEqual(result, { status: "completed", output: { message_id: messages[0].id, channel: "sms", body: "Hi Ana, this is REOS." } });
  });

  it("a lead without an SMS identity is a config failure; Telnyx isn't called", async () => {
    const lead = await newLead();
    await addPrimaryNumber();

    await rejectsWith(execute(sms, await inputFor(lead)), "config", "This record has no phone number for SMS.");
    assert.equal(providers.telnyx.calls.length, 0);
    assert.equal((await rows("messages")).length, 0);
  });

  it("a Telnyx 5xx is a transient failure and nothing is logged", async () => {
    const lead = await newLead();
    await addIdentity(lead, "sms", "+15550102030");
    await addPrimaryNumber();
    providers.telnyx.respondNext(503, { errors: [{ title: "Service Unavailable", detail: "Telnyx is temporarily unavailable." }] });

    await rejectsWith(execute(sms, await inputFor(lead)), "transient", "Telnyx is temporarily unavailable.");
    assert.equal(providers.telnyx.calls.length, 1);
    assert.equal((await rows("messages")).length, 0);
  });

  it("once Telnyx accepts the SMS, a failed message log still reports the send (no second send)", async () => {
    const lead = await newLead();
    await addIdentity(lead, "sms", "+15550102030");
    await addPrimaryNumber();

    const result = await withoutPrivilege("messages", "insert", async () => execute(sms, await inputFor(lead)));

    assert.deepEqual(result, { status: "completed", output: { message_id: null, channel: "sms", body: "Hi Ana, this is REOS." } });
    assert.equal(providers.telnyx.calls.length, 1);
    assert.equal((await rows("messages")).length, 0);
  });
});

// ---------- Send Messenger ----------

describe("send_messenger (live executor → executeSendMessage → deliverMessageToContact → Meta)", () => {
  const messenger = { action: "send_messenger", body: "  Hi {{first_name}}, thanks for messaging us!  " } as const;

  it("DMs the lead's Messenger identity with the Page token and logs the message", async () => {
    const lead = await newLead();
    await addIdentity(lead, "messenger", "psid-123");
    await connectMeta("messenger", { pageId: "page-1", accountId: "page-1", token: "page-token-messenger" });

    const result = await execute(messenger, await inputFor(lead));

    assert.deepEqual(providers.meta.calls, [
      { accessToken: "page-token-messenger", recipientId: "psid-123", text: "Hi Ana, thanks for messaging us!", messagingType: "RESPONSE" },
    ]);
    const messages = await rows<{ id: string; tenant_id: string; contact_id: string; channel: string; direction: string }>("messages");
    assert.equal(messages.length, 1);
    assert.deepEqual(
      [messages[0].tenant_id, messages[0].contact_id, messages[0].channel, messages[0].direction],
      [tenant, lead, "messenger", "outbound"],
    );
    assert.deepEqual(result, {
      status: "completed",
      output: { message_id: messages[0].id, channel: "messenger", body: "Hi Ana, thanks for messaging us!" },
    });
  });

  it("a Facebook commenter without a Messenger identity is a config failure; Meta isn't called", async () => {
    const lead = await newLead();
    await addIdentity(lead, "facebook_comment", "commenter-123");
    await connectMeta("messenger", { pageId: "page-1", accountId: "page-1", token: "page-token-messenger" });

    await rejectsWith(execute(messenger, await inputFor(lead)), "config", "This record has no messenger identity.");
    assert.equal(providers.meta.calls.length, 0);
    assert.equal((await rows("messages")).length, 0);
  });
});

// ---------- Send Instagram ----------

describe("send_instagram (live executor → executeSendMessage → deliverMessageToContact → Meta)", () => {
  const instagram = { action: "send_instagram", body: "Hi {{first_name}}, thanks for the DM!" } as const;
  const account = { pageId: "page-ig", accountId: "ig-business-1", token: "page-token-instagram" };

  it("DMs the lead's Instagram identity with the linked Page token and logs the message", async () => {
    const lead = await newLead();
    await addIdentity(lead, "instagram", "igsid-456");
    await connectMeta("instagram", account);

    const result = await execute(instagram, await inputFor(lead));

    assert.deepEqual(providers.meta.calls, [
      { accessToken: "page-token-instagram", recipientId: "igsid-456", text: "Hi Ana, thanks for the DM!", messagingType: "RESPONSE" },
    ]);
    const messages = await rows<{ id: string; tenant_id: string; contact_id: string; channel: string; direction: string }>("messages");
    assert.equal(messages.length, 1);
    assert.deepEqual(
      [messages[0].tenant_id, messages[0].contact_id, messages[0].channel, messages[0].direction],
      [tenant, lead, "instagram", "outbound"],
    );
    assert.deepEqual(result, {
      status: "completed",
      output: { message_id: messages[0].id, channel: "instagram", body: "Hi Ana, thanks for the DM!" },
    });
  });

  it("an Instagram commenter without an Instagram DM identity is a config failure; Meta isn't called", async () => {
    const lead = await newLead();
    await addIdentity(lead, "instagram_comment", "ig-commenter-456");
    await connectMeta("instagram", account);

    await rejectsWith(execute(instagram, await inputFor(lead)), "config", "This record has no instagram identity.");
    assert.equal(providers.meta.calls.length, 0);
    assert.equal((await rows("messages")).length, 0);
  });

  it("a Meta error response is a transient failure and nothing is logged", async () => {
    const lead = await newLead();
    await addIdentity(lead, "instagram", "igsid-456");
    await connectMeta("instagram", account);
    providers.meta.respondNext(500, { error: { message: "An unexpected error has occurred. Please retry your request later." } });

    await rejectsWith(
      execute(instagram, await inputFor(lead)),
      "transient",
      "An unexpected error has occurred. Please retry your request later.",
    );
    assert.equal(providers.meta.calls.length, 1);
    assert.equal((await rows("messages")).length, 0);
  });
});

// ---------- Send Email ----------

describe("send_email (live executor → agent resolution → Resend → crm_emails)", () => {
  const email = { action: "send_email", subject: "Welcome, {{first_name}}", body: "Hi {{first_name}},\n\nThanks for reaching out." } as const;

  async function agentWithProfile() {
    await addMember(AGENT);
    await db.query("insert into public.profiles (id, display_name, reply_to_email) values ($1, 'Jordan Agent', 'jordan@agency.test')", [AGENT]);
    db.authUsers.set(AGENT, { email: "jordan.login@agency.test" });
  }

  it("emails the lead on behalf of the assigned agent and records the email with the run id", async () => {
    await agentWithProfile();
    const lead = await newLead({ email: "Ana@Example.com", assigned_agent_id: AGENT });
    const input = await inputFor(lead);

    const result = await execute(email, input);

    assert.equal(providers.resend.calls.length, 1);
    const [sent] = providers.resend.calls;
    assert.equal(sent.apiKey, TEST_KEYS.resend);
    assert.equal(sent.to.length, 1);
    assert.match(sent.to[0], /ana@example\.com/);
    assert.match(sent.from, new RegExp(TEST_FROM_EMAIL.replace(".", "\\.")));
    assert.equal(sent.replyTo, "jordan@agency.test");
    assert.equal(sent.subject, "Welcome, Ana");
    assert.equal(sent.html, "<p>Hi Ana,</p>\n<p>Thanks for reaching out.</p>");

    const emails = await rows<{ id: string; tenant_id: string; contact_id: string; subject: string; provider: string; provider_message_id: string; direction: string; metadata: Record<string, unknown> }>("crm_emails");
    assert.equal(emails.length, 1);
    assert.deepEqual(
      [emails[0].tenant_id, emails[0].contact_id, emails[0].subject, emails[0].provider, emails[0].provider_message_id, emails[0].direction],
      [tenant, lead, "Welcome, Ana", "resend", "resend-email-1", "outbound"],
    );
    assert.equal(emails[0].metadata.journey_run_id, input.runId);
    assert.equal(emails[0].metadata.reply_to, "jordan@agency.test");
    assert.deepEqual(result, { status: "completed", output: { email_id: emails[0].id, to: "ana@example.com", subject: "Welcome, Ana" } });
  });

  it("a lead without a valid email is a config failure; Resend isn't called", async () => {
    await agentWithProfile();
    const lead = await newLead({ email: null, assigned_agent_id: AGENT });

    await rejectsWith(execute(email, await inputFor(lead)), "config", "The lead has no valid email address.");
    assert.equal(providers.resend.calls.length, 0);
    assert.equal((await rows("crm_emails")).length, 0);
  });

  it("a Resend 5xx is a transient failure and nothing is recorded", async () => {
    await agentWithProfile();
    const lead = await newLead({ email: "ana@example.com", assigned_agent_id: AGENT });
    providers.resend.respondNext(500, { name: "internal_server_error", message: "Resend is temporarily unavailable." });

    await rejectsWith(execute(email, await inputFor(lead)), "transient", "Resend is temporarily unavailable.");
    assert.equal(providers.resend.calls.length, 1);
    assert.equal((await rows("crm_emails")).length, 0);
  });
});

// ---------- Create Task ----------

describe("create_task (live executor → tasks)", () => {
  const task = { action: "create_task", title: "Call {{first_name}}", notes: "  Ask about {{full_name}}'s timeline.  ", dueInDays: 2 } as const;

  it("creates an open task on the lead and opportunity, due in the configured days", async () => {
    const lead = await newLead();
    const opportunity = await newOpportunity(lead);
    const before = Date.now();

    const result = await execute(task, await inputFor(lead, opportunity));

    const after = Date.now();
    const tasks = await rows<{ id: string; tenant_id: string; contact_id: string; opportunity_id: string; title: string; notes: string; status: string; due_at: Date }>("tasks");
    assert.equal(tasks.length, 1);
    const [row] = tasks;
    assert.deepEqual(
      [row.tenant_id, row.contact_id, row.opportunity_id, row.title, row.notes, row.status],
      [tenant, lead, opportunity, "Call Ana", "Ask about Ana Lima's timeline.", "open"],
    );
    const twoDays = 2 * 24 * 60 * 60_000;
    assert.ok(row.due_at.getTime() >= before + twoDays && row.due_at.getTime() <= after + twoDays, "due two days from now");
    assert.deepEqual(result, { status: "completed", output: { task_id: row.id, due_at: row.due_at.toISOString() } });
  });

  it("a failed insert is a transient failure", async () => {
    const lead = await newLead();

    await withoutPrivilege("tasks", "insert", async () =>
      rejectsWith(execute(task, await inputFor(lead)), "transient", /permission denied/),
    );
    assert.equal((await rows("tasks")).length, 0);
  });
});

// ---------- Assign Lead ----------

describe("assign_lead (live executor → memberships, contacts, opportunities, activity)", () => {
  it("assigns the lead and its unassigned opportunities, leaves assigned ones alone, and logs it", async () => {
    await addMember(AGENT);
    const lead = await newLead();
    const unassigned = await newOpportunity(lead);
    const assigned = await newOpportunity(lead, OTHER_AGENT);

    const result = await execute({ action: "assign_lead", agentUserId: AGENT }, await inputFor(lead));

    assert.deepEqual(result, { status: "completed", output: { assigned_agent_id: AGENT } });
    const [contact] = await db.query<{ assigned_agent_id: string }>("select assigned_agent_id from public.contacts where id = $1", [lead]);
    assert.equal(contact.assigned_agent_id, AGENT);
    const opportunities = new Map(
      (await rows<{ id: string; assigned_agent_id: string }>("opportunities")).map((row) => [row.id, row.assigned_agent_id]),
    );
    assert.equal(opportunities.get(unassigned), AGENT);
    assert.equal(opportunities.get(assigned), OTHER_AGENT);
    const activities = await rows<{ tenant_id: string; contact_id: string; title: string; body: string }>("contact_activities");
    assert.deepEqual(
      activities.map(({ tenant_id, contact_id, title, body }) => ({ tenant_id, contact_id, title, body })),
      [{ tenant_id: tenant, contact_id: lead, title: "Assigned agent updated", body: "Journey assigned this lead." }],
    );
  });

  it("an agent outside the workspace is a config failure and nothing changes", async () => {
    const lead = await newLead();

    await rejectsWith(
      execute({ action: "assign_lead", agentUserId: OUTSIDER }, await inputFor(lead)),
      "config",
      "That team member isn't in this workspace anymore.",
    );
    const [contact] = await db.query<{ assigned_agent_id: string | null }>("select assigned_agent_id from public.contacts where id = $1", [lead]);
    assert.equal(contact.assigned_agent_id, null);
    assert.equal((await rows("contact_activities")).length, 0);
  });
});

// ---------- Update Lead ----------

describe("update_lead (live executor → createLeadUpdateStore → contacts + migration 055 trigger)", () => {
  it("a journey status change records a journey-origin status event with the run id", async () => {
    const lead = await newLead({ lead_status: "Contacted" });
    const input = await inputFor(lead);

    const result = await execute({ action: "update_lead", fields: { lead_status: "Qualified" } }, input);

    assert.deepEqual(result, { status: "completed", output: { updated: ["lead_status"], converted: false } });
    const [contact] = await db.query<{ lead_status: string }>("select lead_status from public.contacts where id = $1", [lead]);
    assert.equal(contact.lead_status, "Qualified");
    const events = await rows<{ tenant_id: string; contact_id: string; from_status: string; to_status: string; origin: string; origin_run_id: string }>(
      "lead_status_events",
    );
    assert.deepEqual(
      events.map(({ tenant_id, contact_id, from_status, to_status, origin, origin_run_id }) => ({
        tenant_id,
        contact_id,
        from_status,
        to_status,
        origin,
        origin_run_id,
      })),
      [{ tenant_id: tenant, contact_id: lead, from_status: "Contacted", to_status: "Qualified", origin: "journey", origin_run_id: input.runId }],
    );
    const activities = await rows<{ title: string; body: string }>("contact_activities");
    assert.deepEqual(activities.map(({ title, body }) => ({ title, body })), [{ title: "Lead updated", body: "Journey set lead status." }]);
  });
});

// ---------- Notify Team ----------

describe("notify_team (live executor → resolveAssignedAgentUserId → notifyMembers → user_notifications)", () => {
  it("notifies the lead's assigned agent, found through the real lookup", async () => {
    await addMember(AGENT);
    await addMember(OTHER_AGENT, "owner");
    const lead = await newLead({ assigned_agent_id: AGENT });

    const result = await execute(
      { action: "notify_team", title: "New lead: {{first_name}}", body: "Say hi to {{full_name}}", recipients: "assigned_agent" },
      await inputFor(lead),
    );

    assert.deepEqual(result, { status: "completed", output: { notified: 1 } });
    const notifications = await rows<{ user_id: string; tenant_id: string; category: string; title: string; body: string; href: string }>(
      "user_notifications",
    );
    assert.deepEqual(
      notifications.map(({ user_id, tenant_id, category, title, body, href }) => ({ user_id, tenant_id, category, title, body, href })),
      [{ user_id: AGENT, tenant_id: tenant, category: "leads", title: "New lead: Ana", body: "Say hi to Ana Lima", href: `/leads/${lead}` }],
    );
  });
});

// ---------- Journey engine → live executor ----------

describe("Journey engine with the live executor", () => {
  it("lead.created → Send SMS → Create Task runs the real executors and completes", async () => {
    const lead = await newLead();
    await addIdentity(lead, "sms", "+15550102030");
    await addPrimaryNumber();
    const [leadRow] = await db.query<Record<string, unknown>>("select * from public.contacts where id = $1", [lead]);

    const store = new MemoryJourneyStore();
    store.contacts.set(lead, { tenantId: tenant, lead: leadRow });
    const journey: JourneySnapshot = {
      nodes: [
        { id: "t", type: "trigger", name: "New lead", description: "", config: { event: "lead.created", filters: [] } },
        { id: "s", type: "action", name: "Text", description: "", config: { action: "send_sms", body: "Welcome, {{first_name}}!" } },
        { id: "k", type: "action", name: "Task", description: "", config: { action: "create_task", title: "Follow up with {{first_name}}", notes: "", dueInDays: 1 } },
      ],
      connections: [
        { id: "t-s", sourceNodeId: "t", targetNodeId: "s", sourceHandle: null, targetHandle: null },
        { id: "s-k", sourceNodeId: "s", targetNodeId: "k", sourceHandle: null, targetHandle: null },
      ],
    };
    store.saveJourney(tenant, "journey-1", journey);
    const ai: JourneyAIExecutor = {
      execute: async () => {
        throw new Error("AI isn't part of this journey.");
      },
    };

    const outcomes = await dispatchJourneyEvent(
      { store, actions: executor, ai },
      { tenantId: tenant, type: "lead.created", sourceId: lead, contactId: lead, entityType: "contact", entityId: lead, payload: {} },
    );

    assert.equal(outcomes.length, 1);
    const [run] = [...store.runs.values()];
    assert.equal(run.status, "completed");
    assert.equal(providers.telnyx.calls.length, 1);
    assert.equal(providers.telnyx.calls[0].text, "Welcome, Ana!");
    const [message] = await rows<{ id: string }>("messages");
    const [task] = await rows<{ id: string; title: string }>("tasks");
    assert.equal((await rows("messages")).length, 1);
    assert.equal((await rows("tasks")).length, 1);
    assert.equal(task.title, "Follow up with Ana");
    const steps = store
      .stepsFor(run.id)
      .filter((step) => step.nodeId !== "t")
      .map(({ nodeId, status, output }) => ({ nodeId, status, output }));
    assert.deepEqual(steps.map(({ nodeId, status }) => [nodeId, status]), [
      ["s", "completed"],
      ["k", "completed"],
    ]);
    assert.equal(steps[0].output?.message_id, message.id);
    assert.equal(steps[1].output?.task_id, task.id);
  });
});
