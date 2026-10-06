/**
 * Durable journey events (migration 060): real triggers and claim/complete/fail
 * functions on PGlite, written through supabase-js with the producers' request
 * headers, delivered by the real dispatcher into dispatchJourneyEvent with an
 * in-memory journey store.
 */

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, beforeEach, describe, it } from "node:test";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  appointmentBookedHeaders,
  leadCreatedHeaders,
  messageReceivedHeaders,
  withJourneyEventHeaders,
} from "../journey-event-headers.ts";
import type { JourneyAIExecutor } from "./ai.ts";
import { dispatchJourneyEvent, type ActionExecutor, type EngineDeps, type JourneyEvent } from "./engine.ts";
import type { JourneySnapshot } from "./graph.ts";
import {
  createSupabaseJourneyEventOutbox,
  dispatchJourneyEvents,
  MAX_JOURNEY_EVENT_ATTEMPTS,
  type JourneyEventOutbox,
} from "./journey-event-outbox.ts";
import { createJourneyEventsTestDb } from "./journey-events-test-db.ts";
import { DEFAULT_OUTBOX_OPTIONS } from "./lead-status-outbox.ts";
import type { TestDb } from "./lead-status-test-db.ts";
import { MemoryJourneyStore } from "./memory-store.ts";

interface EventRow {
  id: string;
  tenant_id: string;
  contact_id: string;
  event_type: string;
  source_id: string;
  entity_type: string;
  entity_id: string | null;
  payload: Record<string, unknown>;
  dispatched_at: Date | null;
  attempt_count: number;
  last_error: string | null;
  failed_at: Date | null;
  next_attempt_at: Date;
  locked_until: Date | null;
  claim_token: string | null;
}

let db: TestDb;
let service: SupabaseClient;
let tenant: string;
let store: MemoryJourneyStore;
let deps: EngineDeps;
let outbox: JourneyEventOutbox;

const ai: JourneyAIExecutor = { execute: async () => ({ success: true, output: {}, text: "" }) };
const actions: ActionExecutor = { execute: async () => ({ status: "completed", output: {} }) };

before(async () => {
  db = await createJourneyEventsTestDb();
});

after(async () => {
  await db.pg.close();
});

beforeEach(async () => {
  await db.reset();
  tenant = await newTenant();
  store = new MemoryJourneyStore();
  deps = { store, actions, ai };
  service = db.client("service_role");
  outbox = createSupabaseJourneyEventOutbox(service);
});

async function newTenant(): Promise<string> {
  const [row] = await db.query<{ id: string }>("insert into public.tenants default values returning id");
  return row.id;
}

/** A lead in Postgres mirrored into the journey store; created without event headers. */
async function newLead(tenantId = tenant): Promise<string> {
  const [row] = await db.query<{ id: string }>("insert into public.contacts (tenant_id) values ($1) returning id", [tenantId]);
  store.contacts.set(row.id, { tenantId, lead: { lead_status: "New", record_type: "lead" } });
  return row.id;
}

async function events(): Promise<EventRow[]> {
  return db.query<EventRow>("select * from public.journey_events order by created_at, id");
}

/** Trigger → task: completes in the same pass. */
function instantJourney(journeyId: string, event: string, tenantId = tenant) {
  const snapshot: JourneySnapshot = {
    nodes: [
      { id: `${journeyId}-t`, type: "trigger", name: "Trigger", description: "", config: { event, filters: [] } },
      { id: `${journeyId}-a`, type: "action", name: "Task", description: "", config: { action: "create_task", title: "Follow up", notes: "", dueInDays: 1 } },
    ],
    connections: [{ id: `${journeyId}-c`, sourceNodeId: `${journeyId}-t`, targetNodeId: `${journeyId}-a`, sourceHandle: null, targetHandle: null }],
  };
  store.saveJourney(tenantId, journeyId, snapshot);
}

/** Trigger → wait 1 day → task: the run stays active. */
function waitingJourney(journeyId: string, event: string) {
  const snapshot: JourneySnapshot = {
    nodes: [
      { id: `${journeyId}-t`, type: "trigger", name: "Trigger", description: "", config: { event, filters: [] } },
      { id: `${journeyId}-w`, type: "action", name: "Wait", description: "", config: { action: "wait", duration: 1, unit: "days" } },
      { id: `${journeyId}-a`, type: "action", name: "Task", description: "", config: { action: "create_task", title: "Follow up", notes: "", dueInDays: 1 } },
    ],
    connections: [
      { id: `${journeyId}-c1`, sourceNodeId: `${journeyId}-t`, targetNodeId: `${journeyId}-w`, sourceHandle: null, targetHandle: null },
      { id: `${journeyId}-c2`, sourceNodeId: `${journeyId}-w`, targetNodeId: `${journeyId}-a`, sourceHandle: null, targetHandle: null },
    ],
  };
  store.saveJourney(tenant, journeyId, snapshot);
}

const runs = () => [...store.runs.values()];

async function drain(dispatch: (event: JourneyEvent) => Promise<unknown> = (event) => dispatchJourneyEvent(deps, event)) {
  return dispatchJourneyEvents(outbox, dispatch, { ...DEFAULT_OUTBOX_OPTIONS, budgetMs: 60_000 });
}

async function deliver(): Promise<string[]> {
  const outcomes: string[] = [];
  await drain(async (event) => {
    const result = await dispatchJourneyEvent(deps, event);
    outcomes.push(...result.map((entry) => entry.result));
    return result;
  });
  return outcomes;
}

/** Makes every pending row due now (skips backoff in tests). */
async function makeDue() {
  await db.query("update public.journey_events set next_attempt_at = now() - interval '1 second' where dispatched_at is null");
}

function insertMessage(
  client: SupabaseClient,
  row: { tenantId: string; contactId: string; channel?: string; direction?: "inbound" | "outbound"; body?: string; providerMessageId?: string | null },
  headers: Record<string, string> = messageReceivedHeaders(),
) {
  return withJourneyEventHeaders(
    client
      .from("messages")
      .insert({
        tenant_id: row.tenantId,
        contact_id: row.contactId,
        channel: row.channel ?? "sms",
        direction: row.direction ?? "inbound",
        body: row.body ?? "Hi there",
        ...(row.providerMessageId === undefined ? {} : { provider_message_id: row.providerMessageId }),
      })
      .select("id")
      .single(),
    headers,
  );
}

describe("lead.created capture", () => {
  it("a manual lead insert with the header records lead.created keyed by the contact id", async () => {
    const { data, error } = await withJourneyEventHeaders(
      service.from("contacts").insert({ tenant_id: tenant, record_type: "lead" }).select("id").single(),
      leadCreatedHeaders("manual"),
    );
    assert.equal(error, null);
    const [event] = await events();
    assert.equal(event.event_type, "lead.created");
    assert.equal(event.tenant_id, tenant);
    assert.equal(event.contact_id, data!.id);
    assert.equal(event.source_id, data!.id);
    assert.equal(event.entity_type, "contact");
    assert.equal(event.entity_id, data!.id);
    assert.deepEqual(event.payload, { source: "manual" });
  });

  it("no header, a client record, or an unknown source records nothing", async () => {
    await service.from("contacts").insert({ tenant_id: tenant, record_type: "lead" });
    await withJourneyEventHeaders(
      service.from("contacts").insert({ tenant_id: tenant, record_type: "contact" }),
      leadCreatedHeaders("manual"),
    );
    await withJourneyEventHeaders(
      service.from("contacts").insert({ tenant_id: tenant, record_type: "lead" }),
      { "x-reos-lead-source": "admin'; drop table contacts; --" },
    );
    assert.equal((await events()).length, 0);
  });

  it("a signed-in user's insert is always source manual with no channel, whatever the headers say", async () => {
    const user = randomUUID();
    await db.query("insert into public.test_memberships (user_id, tenant_id) values ($1, $2)", [user, tenant]);
    const { error } = await withJourneyEventHeaders(
      db.client("authenticated", user).from("contacts").insert({ tenant_id: tenant, record_type: "lead" }),
      leadCreatedHeaders("message", "sms"),
    );
    assert.equal(error, null);
    const [event] = await events();
    assert.deepEqual(event.payload, { source: "manual" });
  });

  it("an intake identity insert records lead.created with channel and source; an invalid channel is dropped", async () => {
    const a = await newLead();
    const b = await newLead();
    await withJourneyEventHeaders(
      service.from("contact_identities").insert({ contact_id: a, channel: "sms", external_id: "15550001111" }),
      leadCreatedHeaders("message", "sms"),
    );
    await withJourneyEventHeaders(
      service.from("contact_identities").insert({ contact_id: b, channel: "facebook_comment", external_id: "fb-1" }),
      { "x-reos-lead-source": "comment", "x-reos-lead-channel": "carrier-pigeon" },
    );
    const rows = await events();
    assert.deepEqual(
      rows.map((row) => [row.contact_id, row.source_id, row.payload]),
      [
        [a, a, { channel: "sms", source: "message" }],
        [b, b, { source: "comment" }],
      ],
    );
  });

  it("an identity insert that loses the uniqueness race records nothing", async () => {
    const winner = await newLead();
    const loser = await newLead();
    const attach = (contactId: string) =>
      withJourneyEventHeaders(
        service.from("contact_identities").insert({ contact_id: contactId, channel: "sms", external_id: "15550002222" }),
        leadCreatedHeaders("message", "sms"),
      );
    assert.equal((await attach(winner)).error, null);
    assert.equal((await attach(loser)).error?.code, "23505");
    assert.deepEqual((await events()).map((row) => row.contact_id), [winner]);
  });
});

describe("message.received capture and provider identity", () => {
  it("an inbound message with a provider id is keyed channel:provider id; the entity is the message row", async () => {
    const lead = await newLead();
    const { data } = await insertMessage(service, { tenantId: tenant, contactId: lead, providerMessageId: "tx-1", body: "Hello" });
    const [event] = await events();
    assert.equal(event.event_type, "message.received");
    assert.equal(event.source_id, "sms:tx-1");
    assert.equal(event.entity_type, "message");
    assert.equal(event.entity_id, data!.id);
    assert.deepEqual(event.payload, { channel: "sms", body: "Hello" });
  });

  it("the same provider message again is rejected (23505) and records no second message or event", async () => {
    const lead = await newLead();
    assert.equal((await insertMessage(service, { tenantId: tenant, contactId: lead, providerMessageId: "tx-1" })).error, null);
    const again = await insertMessage(service, { tenantId: tenant, contactId: lead, providerMessageId: "tx-1" });
    assert.equal(again.error?.code, "23505");
    assert.equal((await db.query("select id from public.messages")).length, 1);
    assert.equal((await events()).length, 1);
  });

  it("the provider id is unique per tenant and channel, not globally", async () => {
    const otherTenant = await newTenant();
    const mine = await newLead();
    const theirs = await newLead(otherTenant);
    assert.equal((await insertMessage(service, { tenantId: tenant, contactId: mine, providerMessageId: "m-1", channel: "messenger" })).error, null);
    assert.equal((await insertMessage(service, { tenantId: tenant, contactId: mine, providerMessageId: "m-1", channel: "instagram" })).error, null);
    assert.equal((await insertMessage(service, { tenantId: otherTenant, contactId: theirs, providerMessageId: "m-1", channel: "messenger" })).error, null);
    const rows = await events();
    assert.deepEqual(rows.map((row) => [row.tenant_id, row.source_id]).sort(), [
      [otherTenant, "messenger:m-1"],
      [tenant, "instagram:m-1"],
      [tenant, "messenger:m-1"],
    ].sort());
  });

  it("without a provider id the event is keyed by the message row id", async () => {
    const lead = await newLead();
    const { data } = await insertMessage(service, { tenantId: tenant, contactId: lead });
    assert.equal((await events())[0].source_id, data!.id);
  });

  it("no header, an outbound message, or a signed-in user's insert records nothing", async () => {
    const user = randomUUID();
    await db.query("insert into public.test_memberships (user_id, tenant_id) values ($1, $2)", [user, tenant]);
    const lead = await newLead();
    await insertMessage(service, { tenantId: tenant, contactId: lead }, {});
    await insertMessage(service, { tenantId: tenant, contactId: lead, direction: "outbound" });
    await insertMessage(db.client("authenticated", user), { tenantId: tenant, contactId: lead });
    assert.equal((await db.query("select id from public.messages")).length, 3);
    assert.equal((await events()).length, 0);
  });

  it("the body in the payload is capped at 1000 characters", async () => {
    const lead = await newLead();
    await insertMessage(service, { tenantId: tenant, contactId: lead, providerMessageId: "long", body: "x".repeat(1500) });
    assert.equal(((await events())[0].payload.body as string).length, 1000);
  });
});

describe("appointment.booked capture", () => {
  const insertAppointment = (
    client: SupabaseClient,
    contactId: string,
    values: Record<string, unknown>,
    headers: Record<string, string> = appointmentBookedHeaders("agent"),
  ) =>
    withJourneyEventHeaders(
      client
        .from("contact_activities")
        .insert({ tenant_id: tenant, contact_id: contactId, activity_type: "appointment", title: "Consult", source: "concierge", ...values })
        .select("id")
        .single(),
      headers,
    );

  it("records the appointment keyed by the activity id with start, end, and booked_by", async () => {
    const lead = await newLead();
    const { data } = await insertAppointment(service, lead, {
      occurred_at: "2026-10-06T15:00:00.000Z",
      ends_at: "2026-10-06T15:30:00.000Z",
    });
    const [event] = await events();
    assert.equal(event.event_type, "appointment.booked");
    assert.equal(event.source_id, data!.id);
    assert.equal(event.entity_type, "appointment");
    assert.equal(event.entity_id, data!.id);
    assert.deepEqual(event.payload, { start: "2026-10-06T15:00:00.000Z", end: "2026-10-06T15:30:00.000Z", booked_by: "agent" });
  });

  it("a team meeting by a signed-in user is booked_by team; a missing end is null", async () => {
    const user = randomUUID();
    await db.query("insert into public.test_memberships (user_id, tenant_id) values ($1, $2)", [user, tenant]);
    const lead = await newLead();
    await insertAppointment(
      db.client("authenticated", user),
      lead,
      { activity_type: "meeting", source: "agent", occurred_at: "2026-10-06T15:00:00.000Z" },
      appointmentBookedHeaders("agent"),
    );
    assert.deepEqual((await events())[0].payload, { start: "2026-10-06T15:00:00.000Z", end: null, booked_by: "team" });
  });

  it("no header, or an activity that is not an appointment or meeting, records nothing", async () => {
    const lead = await newLead();
    await insertAppointment(service, lead, { occurred_at: "2026-10-06T15:00:00.000Z" }, {});
    await insertAppointment(service, lead, { activity_type: "note", source: null });
    assert.equal((await events()).length, 0);
  });

  it("a second concierge booking for the same contact and start is rejected; one appointment, one event", async () => {
    const lead = await newLead();
    const slot = { occurred_at: "2026-10-06T15:00:00.000Z", ends_at: "2026-10-06T15:30:00.000Z" };
    assert.equal((await insertAppointment(service, lead, slot)).error, null);
    assert.equal((await insertAppointment(service, lead, slot)).error?.code, "23505");
    assert.equal((await db.query("select id from public.contact_activities")).length, 1);
    assert.equal((await events()).length, 1);
  });

  it("the slot key leaves other contacts, other times, and team meetings alone", async () => {
    const a = await newLead();
    const b = await newLead();
    const at = "2026-10-06T15:00:00.000Z";
    assert.equal((await insertAppointment(service, a, { occurred_at: at })).error, null);
    assert.equal((await insertAppointment(service, b, { occurred_at: at })).error, null);
    assert.equal((await insertAppointment(service, a, { occurred_at: "2026-10-06T16:00:00.000Z" })).error, null);
    assert.equal((await insertAppointment(service, a, { occurred_at: at, activity_type: "meeting", source: "agent" }, appointmentBookedHeaders("team"))).error, null);
    assert.equal((await insertAppointment(service, a, { occurred_at: at, activity_type: "meeting", source: "agent" }, appointmentBookedHeaders("team"))).error, null);
    assert.equal((await events()).length, 5);
  });
});

describe("task.completed capture", () => {
  async function newTask(contactId: string | null, title = "Call back"): Promise<string> {
    const [row] = await db.query<{ id: string }>(
      "insert into public.tasks (tenant_id, contact_id, title) values ($1, $2, $3) returning id",
      [tenant, contactId, title],
    );
    return row.id;
  }
  const setTaskStatus = (id: string, status: "open" | "done") =>
    service.from("tasks").update({ status }).eq("id", id).eq("tenant_id", tenant);

  it("open → done records task.completed with the task as entity and a fresh occurrence id", async () => {
    const lead = await newLead();
    const task = await newTask(lead);
    await setTaskStatus(task, "done");
    const [event] = await events();
    assert.equal(event.event_type, "task.completed");
    assert.equal(event.contact_id, lead);
    assert.equal(event.entity_type, "task");
    assert.equal(event.entity_id, task);
    assert.match(event.source_id, /^[0-9a-f-]{36}$/);
    assert.notEqual(event.source_id, task);
    assert.deepEqual(event.payload, { task_id: task, title: "Call back" });
  });

  it("done → done, a title edit, and a task without a contact record nothing", async () => {
    const lead = await newLead();
    const task = await newTask(lead);
    await setTaskStatus(task, "done");
    await setTaskStatus(task, "done");
    await service.from("tasks").update({ title: "Renamed" }).eq("id", task);
    await setTaskStatus(await newTask(null), "done");
    assert.equal((await events()).length, 1);
  });

  it("reopen and complete again is a second occurrence with its own id", async () => {
    const lead = await newLead();
    const task = await newTask(lead);
    await setTaskStatus(task, "done");
    await setTaskStatus(task, "open");
    await setTaskStatus(task, "done");
    const rows = await events();
    assert.equal(rows.length, 2);
    assert.notEqual(rows[0].source_id, rows[1].source_id);
  });
});

describe("atomicity with the CRM write", () => {
  it("crash before the event: a rolled-back write leaves no event", async () => {
    const lead = await newLead();
    await db.pg.transaction(async (tx) => {
      await tx.query("select set_config('request.jwt.claims', $1, true), set_config('request.headers', $2, true)", [
        JSON.stringify({ role: "service_role" }),
        JSON.stringify(messageReceivedHeaders()),
      ]);
      await tx.query(
        "insert into public.messages (tenant_id, contact_id, channel, direction, body, provider_message_id) values ($1, $2, 'sms', 'inbound', 'hi', 'tx-rollback')",
        [tenant, lead],
      );
      assert.equal((await tx.query("select id from public.journey_events")).rows.length, 1);
      await tx.rollback();
    });
    assert.equal((await events()).length, 0);
    assert.equal((await db.query("select id from public.messages")).length, 0);
  });

  it("crash after the event: the committed row is delivered by the next drain, exactly once", async () => {
    instantJourney("j-msg", "message.received");
    const lead = await newLead();
    await insertMessage(service, { tenantId: tenant, contactId: lead, providerMessageId: "tx-1" });
    // No fast path ran (the producer died); the cron drain picks it up.
    assert.deepEqual(await deliver(), ["started"]);
    assert.deepEqual(await deliver(), []);
    assert.equal(runs().length, 1);
    assert.equal(runs()[0].idempotencyKey, "message.received:sms:tx-1:j-msg");
  });
});

describe("origin headers are trusted only from the service role", () => {
  /** One write the way PostgREST runs it: claims and headers set locally in the write's transaction. */
  async function writeWith(claims: string | null, headers: Record<string, string>, sql: string, params: unknown[]) {
    await db.pg.transaction(async (tx) => {
      if (claims !== null) await tx.query("select set_config('request.jwt.claims', $1, true)", [claims]);
      await tx.query("select set_config('request.headers', $1, true)", [JSON.stringify(headers)]);
      await tx.query(sql, params);
    });
  }

  const everyOriginHeader = {
    ...leadCreatedHeaders("message", "sms"),
    ...messageReceivedHeaders(),
    ...appointmentBookedHeaders("agent"),
    role: "service_role",
    "x-reos-role": "service_role",
  };

  async function writeAll(claims: string | null, lead: string) {
    await writeWith(claims, everyOriginHeader, "insert into public.contacts (tenant_id, record_type) values ($1, 'lead')", [tenant]);
    await writeWith(
      claims,
      everyOriginHeader,
      "insert into public.messages (tenant_id, contact_id, direction, body, provider_message_id) values ($1, $2, 'inbound', 'hi', gen_random_uuid()::text)",
      [tenant, lead],
    );
    await writeWith(
      claims,
      everyOriginHeader,
      "insert into public.contact_activities (tenant_id, contact_id, activity_type, title) values ($1, $2, 'meeting', 'Consult')",
      [tenant, lead],
    );
  }

  it("anon, no request role (SQL editor, pg_cron), malformed or role-less claims, or a role sent as a header: the writes succeed and record nothing", async () => {
    const lead = await newLead();
    const untrusted = [JSON.stringify({ role: "anon" }), null, "{not json", JSON.stringify({}), JSON.stringify({ role: "SERVICE_ROLE" })];
    for (const claims of untrusted) await writeAll(claims, lead);
    assert.equal((await db.query("select id from public.contacts")).length, 1 + untrusted.length);
    assert.equal((await db.query("select id from public.messages")).length, untrusted.length);
    assert.equal((await db.query("select id from public.contact_activities")).length, untrusted.length);
    assert.equal((await events()).length, 0);

    await writeAll(JSON.stringify({ role: "service_role" }), lead);
    assert.deepEqual((await events()).map((row) => [row.event_type, row.payload.booked_by ?? row.payload.source ?? row.payload.channel]), [
      ["lead.created", "message"],
      ["message.received", "sms"],
      ["appointment.booked", "agent"],
    ]);
  });

  it("a signed-in user's write gets no service origin from the same headers: manual lead without channel, no message.received, team appointment", async () => {
    const lead = await newLead();
    await writeAll(JSON.stringify({ role: "authenticated", sub: randomUUID() }), lead);
    const rows = await events();
    assert.deepEqual(rows.map((row) => row.event_type), ["lead.created", "appointment.booked"]);
    assert.deepEqual(rows[0].payload, { source: "manual" });
    assert.equal(rows[1].payload.booked_by, "team");
  });

  it("events carry no journey lineage: Stage 1 origin headers are ignored and a delivered event never targets or excludes a journey", async () => {
    instantJourney("j-new", "message.received");
    const lead = await newLead();
    const lineage = { "x-reos-origin": "journey", "x-reos-origin-run-id": randomUUID(), "x-reos-actor-user-id": randomUUID() };
    await insertMessage(service, { tenantId: tenant, contactId: lead, providerMessageId: "tx-1", body: "Hi" }, { ...messageReceivedHeaders(), ...lineage });
    await withJourneyEventHeaders(
      service.from("contacts").insert({ tenant_id: tenant, record_type: "lead" }),
      { ...leadCreatedHeaders("message", "sms"), ...lineage },
    );
    assert.deepEqual((await events()).map((row) => row.payload), [
      { channel: "sms", body: "Hi" },
      { channel: "sms", source: "message" },
    ]);
    const delivered: JourneyEvent[] = [];
    await drain(async (event) => {
      delivered.push(event);
      return dispatchJourneyEvent(deps, event);
    });
    assert.equal(delivered.length, 2);
    for (const event of delivered) {
      assert.equal("journeyId" in event, false);
      assert.equal("excludeJourneyId" in event, false);
    }
  });
});

describe("journey event dispatch", () => {
  async function leadCreated(): Promise<string> {
    const { data } = await withJourneyEventHeaders(
      service.from("contacts").insert({ tenant_id: tenant, record_type: "lead" }).select("id").single(),
      leadCreatedHeaders("manual"),
    );
    store.contacts.set(data!.id, { tenantId: tenant, lead: { lead_status: "New", record_type: "lead" } });
    return data!.id;
  }

  it("dispatcher success: the row's identity is the event, the run is keyed by it, and the row is marked dispatched", async () => {
    instantJourney("j-new", "lead.created");
    const lead = await leadCreated();
    const delivered: JourneyEvent[] = [];
    const summary = await drain(async (event) => {
      delivered.push(event);
      return dispatchJourneyEvent(deps, event);
    });
    assert.deepEqual(summary, { claimed: 1, delivered: 1, depthLimited: 0, failed: 0, permanentlyFailed: 0 });
    assert.deepEqual(delivered, [
      { tenantId: tenant, type: "lead.created", sourceId: lead, contactId: lead, entityType: "contact", entityId: lead, payload: { source: "manual" } },
    ]);
    assert.equal(runs()[0].idempotencyKey, `lead.created:${lead}:j-new`);
    const [row] = await events();
    assert.ok(row.dispatched_at);
    assert.equal(row.claim_token, null);
    assert.equal(row.locked_until, null);
  });

  it("dispatcher failure: the row is kept with backoff and delivered on retry, starting one run", async () => {
    instantJourney("j-new", "lead.created");
    await leadCreated();
    const failed = await drain(async () => {
      throw new Error("store unavailable");
    });
    assert.deepEqual(failed, { claimed: 1, delivered: 0, depthLimited: 0, failed: 1, permanentlyFailed: 0 });
    let [row] = await events();
    assert.equal(row.dispatched_at, null);
    assert.equal(row.attempt_count, 1);
    assert.equal(row.last_error, "store unavailable");
    assert.ok(row.next_attempt_at.getTime() > Date.now());
    assert.equal((await drain()).claimed, 0, "not due yet");

    await makeDue();
    assert.deepEqual(await deliver(), ["started"]);
    [row] = await events();
    assert.ok(row.dispatched_at);
    assert.equal(runs().length, 1);
  });

  it("a failure after some journeys started: the retry starts only the missing ones", async () => {
    instantJourney("j-a", "lead.created");
    instantJourney("j-b", "lead.created");
    await leadCreated();
    let calls = 0;
    const flaky = async (event: JourneyEvent) => {
      calls++;
      if (calls === 1) {
        const original = store.createRun.bind(store);
        let created = 0;
        store.createRun = async (input) => {
          if (created++ === 1) throw new Error("lost connection");
          return original(input);
        };
        try {
          return await dispatchJourneyEvent(deps, event);
        } finally {
          store.createRun = original;
        }
      }
      return dispatchJourneyEvent(deps, event);
    };
    await drain(flaky);
    assert.equal(runs().length, 1);
    await makeDue();
    await drain(flaky);
    assert.deepEqual(runs().map((run) => run.journeyId).sort(), ["j-a", "j-b"]);
  });

  it("redelivery of a delivered row (dispatcher died before marking it) starts nothing new", async () => {
    instantJourney("j-new", "lead.created");
    await leadCreated();
    assert.deepEqual(await deliver(), ["started"]);
    await db.query("update public.journey_events set dispatched_at = null");
    assert.deepEqual(await deliver(), ["duplicate"]);
    assert.equal(runs().length, 1);
  });

  it("a row left claimed when complete fails is delivered again after the lease, as a duplicate", async () => {
    instantJourney("j-new", "lead.created");
    await leadCreated();
    const failingComplete: JourneyEventOutbox = { ...outbox, complete: async () => { throw new Error("complete lost"); } };
    const summary = await dispatchJourneyEvents(failingComplete, (event) => dispatchJourneyEvent(deps, event), { ...DEFAULT_OUTBOX_OPTIONS, budgetMs: 60_000 });
    assert.deepEqual(summary, { claimed: 1, delivered: 0, depthLimited: 0, failed: 1, permanentlyFailed: 0 });
    assert.equal((await drain()).claimed, 0, "still leased");
    await db.query("update public.journey_events set locked_until = now() - interval '1 second'");
    assert.deepEqual(await deliver(), ["duplicate"]);
    assert.equal(runs().length, 1);
  });

  /** First delivery starts the run but the row stays claimed (complete lost); the journey is republished; the lease expires. */
  async function redeliverAfterRepublish(republish: () => void): Promise<string[]> {
    const failingComplete: JourneyEventOutbox = { ...outbox, complete: async () => { throw new Error("complete lost"); } };
    await dispatchJourneyEvents(failingComplete, (event) => dispatchJourneyEvent(deps, event), { ...DEFAULT_OUTBOX_OPTIONS, budgetMs: 60_000 });
    assert.equal(runs().length, 1);
    republish();
    await db.query("update public.journey_events set locked_until = now() - interval '1 second'");
    return deliver();
  }

  it("redelivery after a republish while the first run is still active: one active run per contact stops it", async () => {
    waitingJourney("j-wait", "lead.created");
    await leadCreated();
    assert.deepEqual(await redeliverAfterRepublish(() => waitingJourney("j-wait", "lead.created")), ["already_active"]);
    assert.equal(runs().length, 1);
  });

  it("redelivery after a republish once the first run has ended starts nothing new: the run key leaves the version out", async () => {
    instantJourney("j-new", "lead.created");
    await leadCreated();
    assert.deepEqual(await redeliverAfterRepublish(() => instantJourney("j-new", "lead.created")), ["duplicate"]);
    assert.equal(runs().length, 1);
  });

  it("a new event after a republish still starts the new version", async () => {
    instantJourney("j-msg", "message.received");
    const lead = await newLead();
    await insertMessage(service, { tenantId: tenant, contactId: lead, providerMessageId: "tx-1" });
    assert.deepEqual(await deliver(), ["started"]);
    instantJourney("j-msg", "message.received");
    await insertMessage(service, { tenantId: tenant, contactId: lead, providerMessageId: "tx-2" });
    assert.deepEqual(await deliver(), ["started"]);
    assert.deepEqual(runs().map((run) => run.journeyVersion), [1, 2]);
  });

  it("Journey already active: the event is delivered (already_active) and not retried", async () => {
    waitingJourney("j-wait", "message.received");
    const lead = await newLead();
    await insertMessage(service, { tenantId: tenant, contactId: lead, providerMessageId: "tx-1" });
    assert.deepEqual(await deliver(), ["started"]);
    await insertMessage(service, { tenantId: tenant, contactId: lead, providerMessageId: "tx-2" });
    assert.deepEqual(await deliver(), ["already_active"]);
    const rows = await events();
    assert.ok(rows.every((row) => row.dispatched_at));
    assert.equal(runs().length, 1);
    assert.deepEqual(await deliver(), []);
  });

  it("a row is permanently failed after the last attempt and never claimed again", async () => {
    instantJourney("j-new", "lead.created");
    await leadCreated();
    let summary;
    for (let attempt = 1; attempt <= MAX_JOURNEY_EVENT_ATTEMPTS; attempt++) {
      await makeDue();
      summary = await drain(async () => {
        throw new Error("always");
      });
    }
    assert.equal(summary!.permanentlyFailed, 1);
    const [row] = await events();
    assert.ok(row.failed_at);
    assert.equal(row.attempt_count, MAX_JOURNEY_EVENT_ATTEMPTS);
    await makeDue();
    assert.equal((await drain()).claimed, 0);
    assert.equal(runs().length, 0);
  });

  it("a row whose dispatcher crashed on every attempt stops being claimed at the attempt cap", async () => {
    instantJourney("j-new", "lead.created");
    await leadCreated();
    for (let attempt = 1; attempt <= MAX_JOURNEY_EVENT_ATTEMPTS; attempt++) {
      await makeDue();
      assert.equal((await outbox.claim({ limit: 10, leaseSeconds: 60 })).length, 1);
      await db.query("update public.journey_events set locked_until = now() - interval '1 second'");
    }
    await makeDue();
    assert.equal((await outbox.claim({ limit: 10, leaseSeconds: 60 })).length, 0);
    const [row] = await events();
    assert.equal(row.attempt_count, MAX_JOURNEY_EVENT_ATTEMPTS);
    assert.equal(row.dispatched_at, null);
    assert.equal(runs().length, 0);
  });

  it("claims are tenant- and contact-scoped", async () => {
    const otherTenant = await newTenant();
    const mine = await newLead();
    const theirs = await newLead(otherTenant);
    await insertMessage(service, { tenantId: tenant, contactId: mine, providerMessageId: "a" });
    await insertMessage(service, { tenantId: otherTenant, contactId: theirs, providerMessageId: "b" });
    const claimed = await outbox.claim({ limit: 10, leaseSeconds: 60, tenantId: tenant, contactId: mine });
    assert.deepEqual(claimed.map((row) => row.contact_id), [mine]);
    assert.equal((await outbox.claim({ limit: 10, leaseSeconds: 60, tenantId: tenant, contactId: theirs })).length, 0);
  });

  it("an event is only dispatched to its own tenant's journeys", async () => {
    const otherTenant = await newTenant();
    instantJourney("j-theirs", "message.received", otherTenant);
    const lead = await newLead();
    await insertMessage(service, { tenantId: tenant, contactId: lead, providerMessageId: "tx-1" });
    assert.deepEqual(await deliver(), []);
    assert.equal(runs().length, 0);
  });

  it("a contact's events go out in creation order", async () => {
    const lead = await newLead();
    for (const id of ["1", "2", "3"]) await insertMessage(service, { tenantId: tenant, contactId: lead, providerMessageId: id });
    const order: string[] = [];
    await drain(async (event) => {
      order.push(event.sourceId);
    });
    assert.deepEqual(order, ["sms:1", "sms:2", "sms:3"]);
  });

  it("members can read their tenant's events and can't write them", async () => {
    const user = randomUUID();
    const otherTenant = await newTenant();
    await db.query("insert into public.test_memberships (user_id, tenant_id) values ($1, $2)", [user, tenant]);
    const mine = await newLead();
    const theirs = await newLead(otherTenant);
    await insertMessage(service, { tenantId: tenant, contactId: mine, providerMessageId: "a" });
    await insertMessage(service, { tenantId: otherTenant, contactId: theirs, providerMessageId: "b" });
    const member = db.client("authenticated", user);
    const { data } = await member.from("journey_events").select("tenant_id");
    assert.deepEqual((data ?? []).map((row: { tenant_id: string }) => row.tenant_id), [tenant]);
    const { error } = await member.from("journey_events").insert({
      tenant_id: tenant, contact_id: mine, event_type: "lead.created", source_id: "forged", entity_type: "contact",
    });
    assert.ok(error);
    const { error: rpcError } = await member.rpc("claim_journey_events", { p_limit: 10 });
    assert.ok(rpcError);
  });
});

describe("contact merge", () => {
  it("re-pointing pending events before deleting the loser keeps them (merge order)", async () => {
    instantJourney("j-new", "message.received");
    const winner = await newLead();
    const loser = await newLead();
    await insertMessage(service, { tenantId: tenant, contactId: loser, providerMessageId: "tx-1" });
    await service.from("journey_events").update({ contact_id: winner }).eq("contact_id", loser);
    await db.query("delete from public.contacts where id = $1", [loser]);
    const [row] = await events();
    assert.equal(row.contact_id, winner);
    assert.deepEqual(await deliver(), ["started"]);
    assert.equal(runs()[0].contactId, winner);
  });
});
