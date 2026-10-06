/**
 * Lifecycle journey events (migration 061): opportunity.stage_changed,
 * appointment.rescheduled, lead.assigned, lead.handoff_requested. Real triggers
 * on PGlite written through supabase-js (or SQL with the request settings
 * PostgREST sets), delivered by the real journey event dispatcher into
 * dispatchJourneyEvent with an in-memory journey store. Runs the store creates
 * are mirrored into journey_runs, which is where the dispatcher resolves the
 * run behind a journey-caused event.
 */

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, beforeEach, describe, it } from "node:test";
import type { SupabaseClient } from "@supabase/supabase-js";
import { withStatusOrigin } from "../../crm/status-origin.ts";
import {
  appointmentBookedHeaders,
  appointmentRescheduledHeaders,
  withJourneyEventHeaders,
} from "../journey-event-headers.ts";
import type { JourneyAIExecutor } from "./ai.ts";
import { CONDITION_FIELDS, validateNodeConfig, type ConditionRule } from "./contracts.ts";
import {
  dispatchJourneyEvent,
  idempotencyKey,
  runCausationDepth,
  type ActionExecutor,
  type EngineDeps,
  type JourneyEvent,
} from "./engine.ts";
import type { JourneySnapshot, SnapshotNode } from "./graph.ts";
import {
  createSupabaseJourneyEventOutbox,
  dispatchJourneyEvents,
  journeyEventFromRow,
  type JourneyEventOutbox,
  type JourneyEventRow,
} from "./journey-event-outbox.ts";
import { createJourneyEventsTestDb } from "./journey-events-test-db.ts";
import { DEFAULT_OUTBOX_OPTIONS, type OutboxDispatchSummary } from "./lead-status-outbox.ts";
import type { TestDb } from "./lead-status-test-db.ts";
import { MemoryJourneyStore, type MemoryRun } from "./memory-store.ts";

interface EventRow {
  id: string;
  tenant_id: string;
  contact_id: string;
  event_type: string;
  source_id: string;
  entity_type: string;
  entity_id: string | null;
  payload: Record<string, unknown>;
  origin: string | null;
  origin_run_id: string | null;
  dispatched_at: Date | null;
  attempt_count: number;
  last_error: string | null;
  failed_at: Date | null;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const USER = randomUUID();
const AGENT_A = randomUUID();
const AGENT_B = randomUUID();

let db: TestDb;
let service: SupabaseClient;
let member: SupabaseClient;
let tenant: string;
let store: MemoryJourneyStore;
let deps: EngineDeps;
let outbox: JourneyEventOutbox;
/** Memory run id → its uuid in journey_runs. */
let runUuid: Map<string, string>;
/** Journey uuid → readable name. */
let names: Map<string, string>;
let tasks: string[];
let logs: string[];

const ai: JourneyAIExecutor = { execute: async () => ({ success: true, output: {}, text: "" }) };

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
  runUuid = new Map();
  names = new Map();
  tasks = [];
  logs = [];
  service = db.client("service_role");
  member = db.client("authenticated", USER);
  await db.query("insert into public.test_memberships (user_id, tenant_id) values ($1, $2)", [USER, tenant]);
  outbox = createSupabaseJourneyEventOutbox(service);

  const createRun = store.createRun.bind(store);
  store.createRun = async (input) => {
    const result = await createRun(input);
    if (result.created) {
      const id = randomUUID();
      runUuid.set(result.run.id, id);
      await db.query(
        "insert into public.journey_runs (id, tenant_id, journey_id, trigger_event, trigger_payload) values ($1, $2, $3, $4, $5)",
        [id, input.tenantId, input.journeyId, input.triggerEvent, JSON.stringify(input.triggerPayload)],
      );
    }
    return result;
  };

  // Assign lead / Update lead (handoff) as live-actions writes them: service role, journey origin, the run's id.
  const actions: ActionExecutor = {
    async execute(action, input) {
      const journeyName = names.get(input.nodeId.split(":")[0]) ?? "?";
      const runId = runUuid.get(input.runId);
      if (action.action === "assign_lead") {
        const { error } = await withStatusOrigin(
          service.from("contacts").update({ assigned_agent_id: action.agentUserId }).eq("id", input.contactId!).eq("tenant_id", input.tenantId),
          { origin: "journey", originRunId: runId },
        );
        if (error) throw new Error(error.message);
        store.contacts.get(input.contactId!)!.lead.assigned_agent_id = action.agentUserId;
        return { status: "completed", output: { assigned_agent_id: action.agentUserId } };
      }
      if (action.action === "update_lead") {
        const { error } = await withStatusOrigin(
          service.from("contacts").update(action.fields).eq("id", input.contactId!).eq("tenant_id", input.tenantId),
          { origin: "journey", originRunId: runId },
        );
        if (error) throw new Error(error.message);
        Object.assign(store.contacts.get(input.contactId!)!.lead, action.fields);
        return { status: "completed", output: {} };
      }
      tasks.push(`${journeyName}:${action.action}`);
      return { status: "completed", output: {} };
    },
  };
  deps = { store, actions, ai };
});

async function newTenant(): Promise<string> {
  const [row] = await db.query<{ id: string }>("insert into public.tenants default values returning id");
  return row.id;
}

async function newLead(fields: { tenantId?: string; assigned_agent_id?: string | null; handoff?: boolean } = {}): Promise<string> {
  const tenantId = fields.tenantId ?? tenant;
  const [row] = await db.query<{ id: string }>(
    "insert into public.contacts (tenant_id, assigned_agent_id, handoff) values ($1, $2, $3) returning id",
    [tenantId, fields.assigned_agent_id ?? null, fields.handoff ?? false],
  );
  store.contacts.set(row.id, { tenantId, lead: { lead_status: "New", record_type: "lead", assigned_agent_id: fields.assigned_agent_id ?? null, handoff: fields.handoff ?? false } });
  return row.id;
}

async function events(type?: string): Promise<EventRow[]> {
  const rows = await db.query<EventRow>("select * from public.journey_events order by created_at, id");
  return type ? rows.filter((row) => row.event_type === type) : rows;
}

/** One write the way PostgREST runs it: claims and headers set locally in the write's transaction. */
async function writeAs(claims: Record<string, unknown> | string | null, headers: Record<string, string>, sql: string, params: unknown[] = []) {
  await db.pg.transaction(async (tx) => {
    if (claims !== null) {
      await tx.query("select set_config('request.jwt.claims', $1, true)", [typeof claims === "string" ? claims : JSON.stringify(claims)]);
    }
    await tx.query("select set_config('request.headers', $1, true)", [JSON.stringify(headers)]);
    await tx.query(sql, params);
  });
}

const SERVICE = { role: "service_role" };
const SIGNED_IN = { role: "authenticated", sub: USER };

/** Trigger (filters) → actions in order. Node ids are `<journey>:<n>`. */
function journey(name: string, event: string, filters: ConditionRule[], steps: Record<string, unknown>[], tenantId = tenant): string {
  const id = randomUUID();
  names.set(id, name);
  const nodes: SnapshotNode[] = [
    { id: `${id}:t`, type: "trigger", name: "Trigger", description: "", config: { event, filters } },
    ...steps.map((config, index): SnapshotNode => ({ id: `${id}:${index}`, type: "action", name: `Step ${index}`, description: "", config })),
  ];
  const snapshot: JourneySnapshot = {
    nodes,
    connections: nodes.slice(1).map((node, index) => ({
      id: `${id}:c${index}`,
      sourceNodeId: nodes[index].id,
      targetNodeId: node.id,
      sourceHandle: null,
      targetHandle: null,
    })),
  };
  store.saveJourney(tenantId, id, snapshot);
  return id;
}

const task = { action: "create_task", title: "Follow up", notes: "", dueInDays: 1 };
const wait = { action: "wait", duration: 1, unit: "days" };
const assign = (agentUserId: string) => ({ action: "assign_lead", agentUserId });
const rule = (field: string, value: string): ConditionRule => ({ field, operator: "equals", value });

async function drain(dispatch: (event: JourneyEvent) => Promise<unknown> = (event) => dispatchJourneyEvent(deps, event)) {
  return dispatchJourneyEvents(outbox, dispatch, { ...DEFAULT_OUTBOX_OPTIONS, budgetMs: 60_000 }, Date.now, (message) => logs.push(message));
}

/** Delivers until nothing is pending (a delivery may run journeys that record more events). */
async function drainAll(): Promise<OutboxDispatchSummary> {
  const total: OutboxDispatchSummary = { claimed: 0, delivered: 0, depthLimited: 0, failed: 0, permanentlyFailed: 0 };
  for (let round = 0; round < 20; round++) {
    const summary = await drain();
    if (summary.claimed === 0) return total;
    for (const key of Object.keys(total) as (keyof OutboxDispatchSummary)[]) total[key] += summary[key];
  }
  throw new Error("Outbox never drained: unbounded chain");
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

async function makeDue() {
  await db.query("update public.journey_events set next_attempt_at = now() - interval '1 second' where dispatched_at is null");
}

const runs = (): MemoryRun[] => [...store.runs.values()];
const depth = (run: MemoryRun) => runCausationDepth({ triggerEvent: run.triggerEvent, triggerPayload: run.triggerPayload });
const chain = () => runs().map((run) => `${names.get(run.journeyId)} d${depth(run)}`);

/** A journey_runs row standing for a run of `journeyId` in `tenantId`, started by `triggerEvent`. */
async function originRun(journeyId: string, triggerEvent = "manual", triggerPayload: Record<string, unknown> = {}, tenantId = tenant): Promise<string> {
  const [row] = await db.query<{ id: string }>(
    "insert into public.journey_runs (tenant_id, journey_id, trigger_event, trigger_payload) values ($1, $2, $3, $4) returning id",
    [tenantId, journeyId, triggerEvent, JSON.stringify(triggerPayload)],
  );
  return row.id;
}

// ---------- opportunity.stage_changed ----------

async function newOpportunity(contactId: string | null, stage = "New", client: SupabaseClient = service, tenantId = tenant) {
  const { data, error } = await client.from("opportunities").insert({ tenant_id: tenantId, contact_id: contactId, stage }).select("id").single();
  assert.equal(error, null);
  return data!.id as string;
}

const setStage = (id: string, stage: string, client: SupabaseClient = service) =>
  client.from("opportunities").update({ stage }).eq("id", id);

describe("opportunity.stage_changed capture", () => {
  it("insert with a contact records from_stage null → the inserted stage, keyed by a fresh occurrence id", async () => {
    const lead = await newLead();
    const opp = await newOpportunity(lead, "AI_Qualifying");
    const [event] = await events();
    assert.equal(event.event_type, "opportunity.stage_changed");
    assert.equal(event.tenant_id, tenant);
    assert.equal(event.contact_id, lead);
    assert.equal(event.entity_type, "opportunity");
    assert.equal(event.entity_id, opp);
    assert.match(event.source_id, UUID);
    assert.notEqual(event.source_id, opp);
    assert.deepEqual(event.payload, {
      opportunity_id: opp,
      contact_id: lead,
      pipeline: "Intake",
      from_stage: null,
      to_stage: "AI_Qualifying",
      origin: "system",
    });
    assert.equal(event.origin, "system");
    assert.equal(event.origin_run_id, null);
  });

  it("A → B records one event with the point-in-time from and to", async () => {
    const lead = await newLead();
    const opp = await newOpportunity(lead, "Qualified");
    await setStage(opp, "Appointment_Set");
    const rows = await events();
    assert.equal(rows.length, 2);
    assert.deepEqual([rows[1].payload.from_stage, rows[1].payload.to_stage], ["Qualified", "Appointment_Set"]);
  });

  it("A → A (stage written with the same value) and edits to other columns record nothing", async () => {
    const lead = await newLead();
    const opp = await newOpportunity(lead, "Qualified");
    await setStage(opp, "Qualified");
    await service.from("opportunities").update({ name: "Renamed", stage: "Qualified" }).eq("id", opp);
    await service.from("opportunities").update({ name: "Renamed again" }).eq("id", opp);
    assert.equal((await events()).length, 1, "only the insert");
  });

  it("Nurture → Qualified → Nurture is two separate occurrences, each with its own id", async () => {
    const lead = await newLead();
    const opp = await newOpportunity(lead, "Nurture");
    await setStage(opp, "Qualified");
    await setStage(opp, "Nurture");
    const rows = (await events()).slice(1);
    assert.deepEqual(rows.map((row) => [row.payload.from_stage, row.payload.to_stage]), [
      ["Nurture", "Qualified"],
      ["Qualified", "Nurture"],
    ]);
    assert.notEqual(rows[0].source_id, rows[1].source_id);
  });

  it("an opportunity without a contact records nothing, on insert or stage change", async () => {
    const opp = await newOpportunity(null, "New");
    await setStage(opp, "Qualified");
    assert.equal((await events()).length, 0);
  });

  it("tenant and contact come from the row; a contact from another workspace records nothing", async () => {
    const otherTenant = await newTenant();
    const theirs = await newLead({ tenantId: otherTenant });
    const opp = await newOpportunity(theirs, "New", service, tenant);
    await setStage(opp, "Qualified");
    assert.equal((await events()).length, 0);
  });

  it("origin: a signed-in user is 'user' whatever headers say; 'import' only when asked; the service role's x-reos-origin is kept", async () => {
    const lead = await newLead();
    const forged = { "x-reos-origin": "journey", "x-reos-origin-run-id": randomUUID() };
    await withStatusOrigin(member.from("opportunities").insert({ tenant_id: tenant, contact_id: lead, stage: "New" }), { origin: "journey", originRunId: randomUUID() });
    await withJourneyEventHeaders(member.from("opportunities").insert({ tenant_id: tenant, contact_id: lead, stage: "New" }), forged);
    await withStatusOrigin(member.from("opportunities").insert({ tenant_id: tenant, contact_id: lead, stage: "New" }), { origin: "import" });
    await withStatusOrigin(service.from("opportunities").insert({ tenant_id: tenant, contact_id: lead, stage: "New" }), { origin: "ai_agent" });
    await writeAs({ role: "anon" }, forged, "insert into public.opportunities (tenant_id, contact_id) values ($1, $2)", [tenant, lead]);
    await writeAs(null, forged, "insert into public.opportunities (tenant_id, contact_id) values ($1, $2)", [tenant, lead]);
    assert.deepEqual((await events()).map((row) => [row.origin, row.payload.origin]), [
      ["user", "user"],
      ["user", "user"],
      ["import", "import"],
      ["ai_agent", "ai_agent"],
      ["system", "system"],
      ["system", "system"],
    ]);
  });

  it("journey lineage does not apply: a journey-origin write keeps no run id, and the dispatched event never excludes or carries depth", async () => {
    const run = await originRun(randomUUID());
    journey("Won", "opportunity.stage_changed", [], [task]);
    const lead = await newLead();
    await withStatusOrigin(service.from("opportunities").insert({ tenant_id: tenant, contact_id: lead, stage: "New" }), { origin: "journey", originRunId: run });
    const [row] = await events();
    assert.equal(row.origin, "journey");
    assert.equal(row.origin_run_id, null);
    const delivered: JourneyEvent[] = [];
    await drain(async (event) => {
      delivered.push(event);
      return dispatchJourneyEvent(deps, event);
    });
    assert.equal("excludeJourneyId" in delivered[0], false);
    assert.equal("causation_depth" in delivered[0].payload, false);
    assert.deepEqual(chain(), ["Won d1"]);
  });
});

describe("opportunity.stage_changed dispatch", () => {
  it("a trigger filter on trigger.to_stage reads the event, not the current opportunity", async () => {
    journey("Won", "opportunity.stage_changed", [rule("trigger.to_stage", "Closed_Won")], [task]);
    journey("Left nurture", "opportunity.stage_changed", [rule("trigger.from_stage", "Nurture")], [task]);
    const lead = await newLead();
    const opp = await newOpportunity(lead, "Nurture");
    await setStage(opp, "Closed_Won");
    // The CRM has moved on since the event: the opportunity is no longer Closed Won.
    store.contacts.get(lead)!.opportunity = { id: opp, stage: "Qualified" };
    const outcomes = await deliver();
    assert.deepEqual(outcomes.sort(), ["filtered", "filtered", "started", "started"].sort());
    assert.deepEqual(chain().sort(), ["Left nurture d1", "Won d1"]);
  });

  it("the run is keyed by the occurrence id without a version; redelivery starts nothing new", async () => {
    const won = journey("Won", "opportunity.stage_changed", [], [task]);
    const lead = await newLead();
    await newOpportunity(lead, "Closed_Won");
    assert.deepEqual(await deliver(), ["started"]);
    const [row] = await events();
    assert.equal(runs()[0].idempotencyKey, `opportunity.stage_changed:${row.source_id}:${won}`);
    assert.equal(idempotencyKey({ type: "opportunity.stage_changed", sourceId: "x" }, won, 7), `opportunity.stage_changed:x:${won}`);
    await db.query("update public.journey_events set dispatched_at = null");
    assert.deepEqual(await deliver(), ["duplicate"]);
    assert.equal(runs().length, 1);
  });

  it("a failed delivery is retried with backoff and starts exactly one run", async () => {
    journey("Won", "opportunity.stage_changed", [], [task]);
    const lead = await newLead();
    await newOpportunity(lead, "Closed_Won");
    const failed = await drain(async () => {
      throw new Error("store unavailable");
    });
    assert.deepEqual(failed, { claimed: 1, delivered: 0, depthLimited: 0, failed: 1, permanentlyFailed: 0 });
    assert.equal((await drain()).claimed, 0, "not due yet");
    await makeDue();
    assert.deepEqual(await deliver(), ["started"]);
    assert.equal(runs().length, 1);
  });

  it("already_active is unchanged: a stage change while the same journey is active for the contact is delivered and dropped", async () => {
    journey("Stage watcher", "opportunity.stage_changed", [], [wait, task]);
    const lead = await newLead();
    const opp = await newOpportunity(lead, "Qualified");
    assert.deepEqual(await deliver(), ["started"]);
    await setStage(opp, "Appointment_Set");
    assert.deepEqual(await deliver(), ["already_active"]);
    assert.ok((await events()).every((row) => row.dispatched_at));
    assert.equal(runs().length, 1);
  });

  it("is dispatched only to its own workspace's journeys", async () => {
    const otherTenant = await newTenant();
    journey("Theirs", "opportunity.stage_changed", [], [task], otherTenant);
    const lead = await newLead();
    await newOpportunity(lead, "Closed_Won");
    assert.deepEqual(await deliver(), []);
    assert.equal(runs().length, 0);
  });
});

// ---------- appointment.rescheduled ----------

async function newAppointment(contactId: string, start = "2026-10-06T15:00:00.000Z", end: string | null = "2026-10-06T15:30:00.000Z", activityType = "appointment", tenantId = tenant) {
  const [row] = await db.query<{ id: string }>(
    `insert into public.contact_activities (tenant_id, contact_id, activity_type, title, occurred_at, ends_at, source)
     values ($1, $2, $3, 'Consult', $4, $5, 'concierge') returning id`,
    [tenantId, contactId, activityType, start, end],
  );
  return row.id;
}

const reschedule = (
  id: string,
  start: string,
  end: string | null,
  client: SupabaseClient = service,
  headers: Record<string, string> = appointmentRescheduledHeaders("agent"),
) => withJourneyEventHeaders(client.from("contact_activities").update({ occurred_at: start, ends_at: end }).eq("id", id), headers);

describe("appointment.rescheduled capture", () => {
  it("moving the start records old and new times and who moved it, keyed by a fresh occurrence id", async () => {
    const lead = await newLead();
    const appt = await newAppointment(lead);
    await reschedule(appt, "2026-10-07T16:00:00.000Z", "2026-10-07T16:30:00.000Z");
    const [event] = await events();
    assert.equal(event.event_type, "appointment.rescheduled");
    assert.equal(event.contact_id, lead);
    assert.equal(event.entity_type, "appointment");
    assert.equal(event.entity_id, appt);
    assert.match(event.source_id, UUID);
    assert.deepEqual(event.payload, {
      appointment_id: appt,
      contact_id: lead,
      from_start: "2026-10-06T15:00:00.000Z",
      to_start: "2026-10-07T16:00:00.000Z",
      to_end: "2026-10-07T16:30:00.000Z",
      rescheduled_by: "agent",
    });
    assert.equal(event.origin, null);
    assert.equal(event.origin_run_id, null);
  });

  it("the same start (an end-only change, a body edit, the start written again) records nothing", async () => {
    const lead = await newLead();
    const appt = await newAppointment(lead);
    await reschedule(appt, "2026-10-06T15:00:00.000Z", "2026-10-06T16:00:00.000Z");
    await service.from("contact_activities").update({ body: "Rescheduled note" }).eq("id", appt);
    await db.query("update public.contact_activities set occurred_at = occurred_at where id = $1", [appt]);
    assert.equal((await events()).length, 0);
  });

  it("each reschedule is its own occurrence", async () => {
    const lead = await newLead();
    const appt = await newAppointment(lead);
    await reschedule(appt, "2026-10-07T15:00:00.000Z", "2026-10-07T15:30:00.000Z");
    await reschedule(appt, "2026-10-08T15:00:00.000Z", "2026-10-08T15:30:00.000Z");
    await reschedule(appt, "2026-10-06T15:00:00.000Z", null);
    const rows = await events();
    assert.deepEqual(rows.map((row) => [row.payload.from_start, row.payload.to_start, row.payload.to_end]), [
      ["2026-10-06T15:00:00.000Z", "2026-10-07T15:00:00.000Z", "2026-10-07T15:30:00.000Z"],
      ["2026-10-07T15:00:00.000Z", "2026-10-08T15:00:00.000Z", "2026-10-08T15:30:00.000Z"],
      ["2026-10-08T15:00:00.000Z", "2026-10-06T15:00:00.000Z", null],
    ]);
    assert.equal(new Set(rows.map((row) => row.source_id)).size, 3);
  });

  it("only appointments and meetings: moving a note records nothing; a meeting is recorded", async () => {
    const lead = await newLead();
    const note = await newAppointment(lead, undefined, null, "note");
    const meeting = await newAppointment(lead, undefined, null, "meeting");
    await reschedule(note, "2026-10-09T15:00:00.000Z", null);
    await reschedule(meeting, "2026-10-09T15:00:00.000Z", null);
    assert.deepEqual((await events()).map((row) => row.entity_id), [meeting]);
  });

  it("recorded whatever path created the appointment (no booking header, no booking event)", async () => {
    const lead = await newLead();
    const appt = await newAppointment(lead);
    assert.equal((await events()).length, 0, "created without a booking event");
    await reschedule(appt, "2026-10-07T15:00:00.000Z", null);
    assert.deepEqual((await events()).map((row) => row.event_type), ["appointment.rescheduled"]);
  });

  it("rescheduled_by: signed-in users are team whatever they send; the service role's agent/team is kept; anything else is system", async () => {
    const lead = await newLead();
    const appt = await newAppointment(lead);
    const at = (day: number) => `2026-10-${String(day).padStart(2, "0")}T15:00:00.000Z`;
    await reschedule(appt, at(10), null, member, appointmentRescheduledHeaders("agent"));
    await reschedule(appt, at(11), null, service, appointmentRescheduledHeaders("team"));
    await reschedule(appt, at(12), null, service, {});
    await reschedule(appt, at(13), null, service, { "x-reos-appointment-rescheduled-by": "ceo" });
    await writeAs({ role: "anon" }, appointmentRescheduledHeaders("agent"), "update public.contact_activities set occurred_at = $2 where id = $1", [appt, at(14)]);
    await writeAs(null, appointmentRescheduledHeaders("agent"), "update public.contact_activities set occurred_at = $2 where id = $1", [appt, at(15)]);
    assert.deepEqual((await events()).map((row) => row.payload.rescheduled_by), ["team", "team", "system", "system", "system", "system"]);
  });

  it("a row whose contact is in another workspace records nothing", async () => {
    const otherTenant = await newTenant();
    const theirs = await newLead({ tenantId: otherTenant });
    const appt = await newAppointment(theirs, undefined, null, "appointment", tenant);
    await reschedule(appt, "2026-10-07T15:00:00.000Z", null);
    assert.equal((await events()).length, 0);
  });

  it("booking is unchanged: a booked insert records appointment.booked only", async () => {
    const lead = await newLead();
    await withJourneyEventHeaders(
      service.from("contact_activities").insert({
        tenant_id: tenant, contact_id: lead, activity_type: "appointment", title: "Consult", source: "concierge",
        occurred_at: "2026-10-06T15:00:00.000Z", ends_at: "2026-10-06T15:30:00.000Z",
      }),
      appointmentBookedHeaders("agent"),
    );
    assert.deepEqual((await events()).map((row) => [row.event_type, row.payload]), [
      ["appointment.booked", { start: "2026-10-06T15:00:00.000Z", end: "2026-10-06T15:30:00.000Z", booked_by: "agent" }],
    ]);
  });
});

describe("appointment.rescheduled dispatch", () => {
  it("dispatch, retry, and redelivery: one run per occurrence; filters read the payload", async () => {
    journey("Agent moved it", "appointment.rescheduled", [rule("trigger.rescheduled_by", "agent")], [task]);
    const lead = await newLead();
    const appt = await newAppointment(lead);
    await reschedule(appt, "2026-10-07T15:00:00.000Z", null);
    await drain(async () => {
      throw new Error("lost connection");
    });
    await makeDue();
    assert.deepEqual(await deliver(), ["started"]);
    await db.query("update public.journey_events set dispatched_at = null");
    assert.deepEqual(await deliver(), ["duplicate"]);
    await reschedule(appt, "2026-10-08T15:00:00.000Z", null, member);
    assert.deepEqual(await deliver(), ["filtered"]);
    assert.equal(runs().length, 1);
  });

  it("Phase D caveat, as documented: a reminder run started by the booking keeps the old time; a second reschedule while the reschedule journey is active is dropped", async () => {
    const reminder = journey("Reminder", "appointment.booked", [], [wait, task]);
    journey("Rescheduled notice", "appointment.rescheduled", [], [wait, task]);
    const lead = await newLead();
    const { data } = await withJourneyEventHeaders(
      service.from("contact_activities").insert({
        tenant_id: tenant, contact_id: lead, activity_type: "appointment", title: "Consult", source: "concierge",
        occurred_at: "2026-10-06T15:00:00.000Z", ends_at: "2026-10-06T15:30:00.000Z",
      }).select("id").single(),
      appointmentBookedHeaders("agent"),
    );
    assert.deepEqual(await deliver(), ["started"]);

    await reschedule(data!.id, "2026-10-09T15:00:00.000Z", null);
    assert.deepEqual(await deliver(), ["started"]);
    const reminderRun = runs().find((run) => run.journeyId === reminder)!;
    assert.equal(reminderRun.status, "waiting", "the reminder run is neither cancelled nor replaced");
    assert.equal(reminderRun.triggerPayload.start, "2026-10-06T15:00:00.000Z", "and still holds the original time");

    await reschedule(data!.id, "2026-10-10T15:00:00.000Z", null);
    assert.deepEqual(await deliver(), ["already_active"]);
    assert.equal(runs().length, 2);
  });
});

// ---------- lead.assigned ----------

const setAgent = (contactId: string, agent: string | null, client: SupabaseClient = service) =>
  client.from("contacts").update({ assigned_agent_id: agent }).eq("id", contactId);

describe("lead.assigned capture", () => {
  it("null → agent records from null, to the agent, keyed by a fresh occurrence id", async () => {
    const lead = await newLead();
    await setAgent(lead, AGENT_A);
    const [event] = await events();
    assert.equal(event.event_type, "lead.assigned");
    assert.equal(event.contact_id, lead);
    assert.equal(event.entity_type, "contact");
    assert.equal(event.entity_id, lead);
    assert.match(event.source_id, UUID);
    assert.deepEqual(event.payload, { contact_id: lead, from_agent_id: null, to_agent_id: AGENT_A, origin: "system" });
  });

  it("agent A → agent B records the reassignment", async () => {
    const lead = await newLead({ assigned_agent_id: AGENT_A });
    await setAgent(lead, AGENT_B, member);
    const [event] = await events();
    assert.deepEqual(event.payload, { contact_id: lead, from_agent_id: AGENT_A, to_agent_id: AGENT_B, origin: "user" });
  });

  it("the same agent, agent → null, null → null, and an insert with an agent record nothing", async () => {
    const lead = await newLead({ assigned_agent_id: AGENT_A });
    await setAgent(lead, AGENT_A);
    await setAgent(lead, null);
    await setAgent(lead, null);
    await service.from("contacts").update({ first_name: "Ana" }).eq("id", lead);
    await newLead({ assigned_agent_id: AGENT_B });
    assert.equal((await events()).length, 0);
  });

  it("A → B → A is two occurrences", async () => {
    const lead = await newLead({ assigned_agent_id: AGENT_A });
    await setAgent(lead, AGENT_B);
    await setAgent(lead, AGENT_A);
    const rows = await events();
    assert.deepEqual(rows.map((row) => row.payload.to_agent_id), [AGENT_B, AGENT_A]);
    assert.notEqual(rows[0].source_id, rows[1].source_id);
  });

  it("a filter on trigger.to_agent_id reads the event, not the current lead", async () => {
    journey("Intro from A", "lead.assigned", [rule("trigger.to_agent_id", AGENT_A)], [task]);
    const lead = await newLead();
    await setAgent(lead, AGENT_A);
    store.contacts.get(lead)!.lead.assigned_agent_id = AGENT_B;
    assert.deepEqual(await deliver(), ["started"]);
  });
});

// ---------- lead.handoff_requested ----------

const setHandoff = (contactId: string, handoff: boolean, client: SupabaseClient = service) =>
  client.from("contacts").update({ handoff }).eq("id", contactId);

describe("lead.handoff_requested capture", () => {
  it("false → true records the request", async () => {
    const lead = await newLead();
    await withStatusOrigin(setHandoff(lead, true), { origin: "ai_agent" });
    const [event] = await events();
    assert.equal(event.event_type, "lead.handoff_requested");
    assert.equal(event.entity_id, lead);
    assert.match(event.source_id, UUID);
    assert.deepEqual(event.payload, { contact_id: lead, origin: "ai_agent" });
    assert.equal(event.origin, "ai_agent");
  });

  it("true → true, true → false, and false → false record nothing; a new request after clearing is a new occurrence", async () => {
    const lead = await newLead();
    await setHandoff(lead, false);
    await setHandoff(lead, true);
    await setHandoff(lead, true);
    await setHandoff(lead, false, member);
    await setHandoff(lead, true, member);
    const rows = await events();
    assert.deepEqual(rows.map((row) => row.origin), ["system", "user"]);
    assert.notEqual(rows[0].source_id, rows[1].source_id);
  });
});

// ---------- Lineage (lead.assigned, lead.handoff_requested) ----------

describe("journey lineage on lead events", () => {
  it("only the service role can attach journey lineage; signed-in, anon, and role-less writes can't forge it", async () => {
    const lead = await newLead();
    const run = await originRun(randomUUID());
    const forged = { "x-reos-origin": "journey", "x-reos-origin-run-id": run };
    await writeAs(SIGNED_IN, forged, "update public.contacts set assigned_agent_id = $2 where id = $1", [lead, AGENT_A]);
    await writeAs({ role: "anon" }, forged, "update public.contacts set assigned_agent_id = $2 where id = $1", [lead, AGENT_B]);
    await writeAs(null, forged, "update public.contacts set assigned_agent_id = $2 where id = $1", [lead, AGENT_A]);
    await writeAs("{not json", forged, "update public.contacts set assigned_agent_id = $2 where id = $1", [lead, AGENT_B]);
    await writeAs(SERVICE, { "x-reos-origin": "journey", "x-reos-origin-run-id": "not-a-uuid" }, "update public.contacts set assigned_agent_id = $2 where id = $1", [lead, AGENT_A]);
    await writeAs(SERVICE, { "x-reos-origin": "ai_agent", "x-reos-origin-run-id": run }, "update public.contacts set assigned_agent_id = $2 where id = $1", [lead, AGENT_B]);
    await writeAs(SERVICE, forged, "update public.contacts set assigned_agent_id = $2 where id = $1", [lead, AGENT_A]);
    assert.deepEqual((await events()).map((row) => [row.origin, row.origin_run_id]), [
      ["user", null],
      ["system", null],
      ["system", null],
      ["system", null],
      ["journey", null],
      ["ai_agent", null],
      ["journey", run],
    ]);
  });

  it("a journey's assignment goes to every other eligible journey, never back to its own; depth and lineage come from the run", async () => {
    const assigner = journey("Assigner", "lead.handoff_requested", [], [assign(AGENT_A)]);
    journey("Intro", "lead.assigned", [], [task]);
    const lead = await newLead();

    await setHandoff(lead, true, member);
    await drainAll();

    assert.deepEqual(chain().sort(), ["Assigner d1", "Intro d2"].sort());
    const [, assigned] = await events();
    const assignerRun = runs().find((run) => run.journeyId === assigner)!;
    assert.equal(assigned.origin, "journey");
    assert.equal(assigned.origin_run_id, runUuid.get(assignerRun.id));
    const intro = runs().find((run) => names.get(run.journeyId) === "Intro")!;
    assert.deepEqual(intro.triggerPayload, {
      contact_id: lead,
      from_agent_id: null,
      to_agent_id: AGENT_A,
      origin: "journey",
      origin_run_id: runUuid.get(assignerRun.id),
      causation_depth: 1,
      origin_journey_id: assigner,
      root_run_id: runUuid.get(assignerRun.id),
    });
  });

  it("the originating journey is excluded even when it listens for its own event", async () => {
    journey("Round robin", "lead.assigned", [], [assign(AGENT_B)]);
    const lead = await newLead();
    await setAgent(lead, AGENT_A, member);
    await drainAll();
    assert.deepEqual(chain(), ["Round robin d1"]);
    assert.deepEqual((await events()).map((row) => row.payload.to_agent_id), [AGENT_A, AGENT_B]);
  });

  it("causation depth bounds assignment chains: the depth-3 event starts nothing and is still dispatched", async () => {
    journey("To B", "lead.assigned", [rule("trigger.to_agent_id", AGENT_A)], [assign(AGENT_B)]);
    journey("To A", "lead.assigned", [rule("trigger.to_agent_id", AGENT_B)], [assign(AGENT_A)]);
    const lead = await newLead();

    await setAgent(lead, AGENT_A, member);
    const summary = await drainAll();

    assert.deepEqual(chain(), ["To B d1", "To A d2", "To B d3"]);
    const rows = await events();
    assert.deepEqual(rows.map((row) => row.origin), ["user", "journey", "journey", "journey"]);
    assert.ok(rows.every((row) => row.dispatched_at && row.attempt_count === 1 && row.last_error === null));
    assert.equal(summary.depthLimited, 1);
    assert.equal(logs.length, 1);
    assert.match(logs[0], new RegExp(`lead.assigned event ${rows[3].id} started no journeys: causation depth 3 reached the limit of 3`));
  });

  it("a journey-caused handoff carries lineage, and a depth-3 handoff starts nothing", async () => {
    const setter = journey("Escalate", "lead.created", [], [{ action: "update_lead", fields: { handoff: true } }]);
    journey("Alert team", "lead.handoff_requested", [], [task]);
    const lead = await newLead();
    await dispatchJourneyEvent(deps, { tenantId: tenant, type: "lead.created", sourceId: lead, contactId: lead, entityType: "contact", entityId: lead, payload: {} });
    await drainAll();
    assert.deepEqual(chain().sort(), ["Alert team d2", "Escalate d1"]);
    const alert = runs().find((run) => names.get(run.journeyId) === "Alert team")!;
    assert.equal(alert.triggerPayload.origin_journey_id, setter);
    assert.equal(alert.triggerPayload.causation_depth, 1);

    const deep = await newLead();
    const deepRun = await originRun(randomUUID(), "lead.status_changed", { causation_depth: 2 });
    await withStatusOrigin(setHandoff(deep, true), { origin: "journey", originRunId: deepRun });
    const summary = await drain();
    assert.deepEqual(summary, { claimed: 1, delivered: 1, depthLimited: 1, failed: 0, permanentlyFailed: 0 });
    assert.equal(runs().length, 2);
  });

  it("an origin run from another workspace resolves to nothing: depth 0, no exclusion, no lineage keys", async () => {
    const otherTenant = await newTenant();
    // A journey here with the id the foreign run names, so an exclusion would be visible.
    const sameId = journey("Same id", "lead.assigned", [], [task]);
    const foreignRun = await originRun(sameId, "lead.status_changed", { causation_depth: 2 }, otherTenant);
    const lead = await newLead();
    await withStatusOrigin(setAgent(lead, AGENT_A), { origin: "journey", originRunId: foreignRun });
    const delivered: JourneyEvent[] = [];
    await drain(async (event) => {
      delivered.push(event);
      return dispatchJourneyEvent(deps, event);
    });
    assert.equal(delivered[0].payload.causation_depth, 0);
    assert.equal(delivered[0].payload.origin_run_id, foreignRun);
    assert.equal("origin_journey_id" in delivered[0].payload, false);
    assert.equal("excludeJourneyId" in delivered[0], false);
    assert.equal(runs().length, 1);
  });

  it("lineage is derived, never read from the stored payload", () => {
    const row: JourneyEventRow = {
      id: randomUUID(), tenant_id: tenant, contact_id: randomUUID(), event_type: "lead.assigned", source_id: randomUUID(),
      entity_type: "contact", entity_id: null, created_at: new Date().toISOString(), attempt_count: 1, claim_token: null,
      payload: { to_agent_id: AGENT_A, causation_depth: 0, origin_journey_id: "forged", root_run_id: "forged" },
      origin: "journey", origin_run_id: randomUUID(),
    };
    const event = journeyEventFromRow(row, { journeyId: "j-real", triggerEvent: "lead.status_changed", triggerPayload: { causation_depth: 1 } });
    assert.equal(event.payload.causation_depth, 2);
    assert.equal(event.payload.origin_journey_id, "j-real");
    assert.equal(event.payload.root_run_id, row.origin_run_id);
    assert.equal(event.excludeJourneyId, "j-real");
    const unresolved = journeyEventFromRow(row, null);
    assert.equal(unresolved.payload.causation_depth, 0);
    assert.equal("origin_journey_id" in unresolved.payload, false);
    assert.equal("root_run_id" in unresolved.payload, false);
    const notJourney = journeyEventFromRow({ ...row, origin: "user" }, { journeyId: "j-real", triggerEvent: "lead.status_changed", triggerPayload: { causation_depth: 1 } });
    assert.equal(notJourney.payload.causation_depth, 0, "a run is only lineage for a journey-origin row");
    assert.equal("origin_journey_id" in notJourney.payload, false);
    assert.equal("excludeJourneyId" in notJourney, false);
  });

  it("a journey-origin assignment does not touch Stage 1: no lead status event is recorded", async () => {
    const lead = await newLead();
    await withStatusOrigin(setAgent(lead, AGENT_A), { origin: "journey", originRunId: await originRun(randomUUID()) });
    assert.equal((await db.query("select id from public.lead_status_events")).length, 0);
  });
});

// ---------- Contracts ----------

describe("trigger contracts", () => {
  it("the four events are selectable triggers; their payload fields are valid filters, offered only for their own event", () => {
    for (const event of ["opportunity.stage_changed", "appointment.rescheduled", "lead.assigned", "lead.handoff_requested"]) {
      assert.deepEqual(validateNodeConfig("trigger", { event, filters: [] }, "strict").errors, []);
    }
    const ok = (event: string, field: string, value: string) =>
      validateNodeConfig("trigger", { event, filters: [rule(field, value)] }, "strict").errors;
    assert.deepEqual(ok("opportunity.stage_changed", "trigger.to_stage", "Closed_Won"), []);
    assert.deepEqual(ok("opportunity.stage_changed", "trigger.from_stage", "Nurture"), []);
    assert.deepEqual(ok("appointment.rescheduled", "trigger.rescheduled_by", "team"), []);
    assert.deepEqual(ok("lead.assigned", "trigger.to_agent_id", AGENT_A), []);
    assert.deepEqual(
      Object.fromEntries(
        ["trigger.from_stage", "trigger.to_stage", "trigger.rescheduled_by", "trigger.from_agent_id", "trigger.to_agent_id"].map((field) => [
          field,
          CONDITION_FIELDS[field].events,
        ]),
      ),
      {
        "trigger.from_stage": ["opportunity.stage_changed"],
        "trigger.to_stage": ["opportunity.stage_changed"],
        "trigger.rescheduled_by": ["appointment.rescheduled"],
        "trigger.from_agent_id": ["lead.assigned"],
        "trigger.to_agent_id": ["lead.assigned"],
      },
    );
  });
});
