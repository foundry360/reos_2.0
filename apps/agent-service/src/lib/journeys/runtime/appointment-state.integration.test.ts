/**
 * Appointment state (migration 062): scheduled → cancelled | completed | no_show
 * on the existing contact_activities rows, the journey event each transition
 * records, and journeys that start from or check that state. Real triggers on
 * PGlite written through supabase-js (or SQL with the request settings
 * PostgREST sets), delivered by the real journey event dispatcher into
 * dispatchJourneyEvent. Runs live in the in-memory journey store; lead,
 * opportunity, and appointment context come from the real Supabase store's
 * loadEntities. live-actions-test-env.ts must be the first import; it fails
 * closed on any other network access.
 */

import { attachTestDb, blockedRequests } from "./live-actions-test-env.ts";

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, afterEach, before, beforeEach, describe, it } from "node:test";
import type { SupabaseClient } from "@supabase/supabase-js";
import { setAppointmentStatus } from "../../calendar/appointment-status.ts";
import { appointmentBookedHeaders, appointmentRescheduledHeaders, withJourneyEventHeaders } from "../journey-event-headers.ts";
import type { JourneyAIExecutor } from "./ai.ts";
import {
  CONDITION_FIELDS,
  isImplementedTriggerEvent,
  validateNodeConfig,
  type ConditionRule,
} from "./contracts.ts";
import {
  appointmentIdOf,
  dispatchJourneyEvent,
  idempotencyKey,
  resumeDueRuns,
  type ActionExecutor,
  type EngineDeps,
  type JourneyEvent,
} from "./engine.ts";
import type { JourneySnapshot, SnapshotNode } from "./graph.ts";
import {
  createSupabaseJourneyEventOutbox,
  dispatchJourneyEvents,
  JOURNEY_EVENT_TYPES,
  LINEAGE_EVENT_TYPES,
  type JourneyEventOutbox,
} from "./journey-event-outbox.ts";
import { createJourneyEventsTestDb } from "./journey-events-test-db.ts";
import { DEFAULT_OUTBOX_OPTIONS } from "./lead-status-outbox.ts";
import type { TestDb } from "./lead-status-test-db.ts";
import { MemoryJourneyStore, type MemoryRun } from "./memory-store.ts";

// After the test environment: the store resolves the app's `@/` imports.
const { createSupabaseJourneyStore } = await import("./supabase-store.ts");

/** The rest of the lead and run columns the Supabase store reads (loadEntities, createRun). */
const STORE_COLUMNS = `
alter table public.contacts
  add column lead_temperature text,
  add column qualification_score integer,
  add column opted_out boolean not null default false,
  add column target_location text,
  add column property_type text,
  add column budget text,
  add column timeline text,
  add column financing_status text;
alter table public.journey_runs
  add column entity_type text not null default 'contact',
  add column entity_id uuid,
  add column current_node_id text,
  add column context jsonb not null default '{}'::jsonb,
  add column error text,
  add column resume_at timestamptz,
  add column started_at timestamptz not null default now();
`;

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
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const USER = randomUUID();
const START = "2026-10-06T15:00:00.000Z";
const END = "2026-10-06T15:30:00.000Z";
/** After the appointment started, so completed and no-show are allowed. */
const AFTER_START = new Date("2026-10-06T15:10:00.000Z");
const STATUS_EVENTS = ["appointment.cancelled", "appointment.completed", "appointment.no_show"] as const;

let db: TestDb;
let service: SupabaseClient;
let member: SupabaseClient;
let tenant: string;
let store: MemoryJourneyStore;
let deps: EngineDeps;
let outbox: JourneyEventOutbox;
let clock: Date;
/** Journey uuid → readable name. */
let names: Map<string, string>;
/** `<journey name>:<task title>` per create_task the journeys ran. */
let tasks: string[];

const ai: JourneyAIExecutor = { execute: async () => ({ success: true, output: {}, text: "" }) };

before(async () => {
  db = await createJourneyEventsTestDb(STORE_COLUMNS);
  attachTestDb(db);
});

after(async () => {
  await db.pg.close();
});

beforeEach(async () => {
  await db.reset();
  [{ id: tenant }] = await db.query<{ id: string }>("insert into public.tenants default values returning id");
  service = db.client("service_role");
  member = db.client("authenticated", USER);
  await db.query("insert into public.test_memberships (user_id, tenant_id) values ($1, $2)", [USER, tenant]);
  outbox = createSupabaseJourneyEventOutbox(service);
  names = new Map();
  tasks = [];
  clock = new Date("2026-10-05T12:00:00.000Z");
  store = new MemoryJourneyStore();
  store.clock = () => new Date(clock);
  const supabaseStore = createSupabaseJourneyStore(service);
  store.loadEntities = (tenantId, contactId, appointmentId) => supabaseStore.loadEntities(tenantId, contactId, appointmentId);
  const actions: ActionExecutor = {
    async execute(action, input) {
      const name = names.get(input.nodeId.split(":")[0]) ?? "?";
      tasks.push(`${name}:${"title" in action ? action.title : action.action}`);
      return { status: "completed", output: {} };
    },
  };
  deps = { store, actions, ai, now: () => new Date(clock) };
});

afterEach(() => {
  assert.deepEqual(blockedRequests, [], "no request may leave the test environment");
});

async function newTenant(): Promise<string> {
  const [row] = await db.query<{ id: string }>("insert into public.tenants default values returning id");
  return row.id;
}

async function newLead(tenantId = tenant): Promise<string> {
  const [row] = await db.query<{ id: string }>("insert into public.contacts (tenant_id) values ($1) returning id", [tenantId]);
  return row.id;
}

/** An appointment as the booking paths insert it, recording appointment.booked (060). */
async function newAppointment(
  contactId: string,
  fields: { activityType?: string; start?: string; end?: string | null; metadata?: Record<string, unknown>; opportunityId?: string; tenantId?: string } = {},
): Promise<string> {
  const { data, error } = await withJourneyEventHeaders(
    service
      .from("contact_activities")
      .insert({
        tenant_id: fields.tenantId ?? tenant,
        contact_id: contactId,
        activity_type: fields.activityType ?? "appointment",
        title: "Consult",
        occurred_at: fields.start ?? START,
        ends_at: fields.end === undefined ? END : fields.end,
        source: "concierge",
        metadata: fields.metadata ?? null,
        related_entity_type: fields.opportunityId ? "opportunity" : null,
        related_entity_id: fields.opportunityId ?? null,
      })
      .select("id")
      .single(),
    appointmentBookedHeaders("agent"),
  );
  assert.equal(error, null);
  return data!.id;
}

async function appointmentRow(id: string) {
  const [row] = await db.query<{ appointment_status: string | null; occurred_at: Date; metadata: Record<string, unknown> | null }>(
    "select appointment_status, occurred_at, metadata from public.contact_activities where id = $1",
    [id],
  );
  return row;
}

async function events(type?: string): Promise<EventRow[]> {
  const rows = await db.query<EventRow>("select * from public.journey_events order by created_at, id");
  return type ? rows.filter((row) => row.event_type === type) : rows;
}

const statusEvents = async () => (await events()).filter((row) => (STATUS_EVENTS as readonly string[]).includes(row.event_type));

const setStatus = (id: string, status: "cancelled" | "completed" | "no_show", client: SupabaseClient = member, now = AFTER_START) =>
  setAppointmentStatus(client, { tenantId: tenant, appointmentId: id, status, now });

/** One write the way PostgREST runs it: claims and headers set locally in the write's transaction. */
async function writeAs(claims: Record<string, unknown> | null, sql: string, params: unknown[] = [], headers: Record<string, string> = {}) {
  await db.pg.transaction(async (tx) => {
    if (claims !== null) await tx.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify(claims)]);
    await tx.query("select set_config('request.headers', $1, true)", [JSON.stringify(headers)]);
    await tx.query(sql, params);
  });
}

async function rejects(promise: Promise<unknown>, pattern: RegExp) {
  await assert.rejects(promise, (error: Error) => pattern.test(error.message));
}

function node(id: string, type: SnapshotNode["type"], config: Record<string, unknown>): SnapshotNode {
  return { id, type, name: id, description: "", config };
}

function link(source: string, target: string, sourceHandle: string | null = null) {
  return { id: `${source}->${target}`, sourceNodeId: source, targetNodeId: target, sourceHandle, targetHandle: null };
}

/** Trigger (filters) → actions in order. */
function journey(name: string, event: string, filters: ConditionRule[], steps: Record<string, unknown>[], tenantId = tenant): string {
  const id = randomUUID();
  names.set(id, name);
  const nodes = [node(`${id}:t`, "trigger", { event, filters }), ...steps.map((config, index) => node(`${id}:${index}`, "action", config))];
  const snapshot: JourneySnapshot = { nodes, connections: nodes.slice(1).map((entry, index) => link(nodes[index].id, entry.id)) };
  store.saveJourney(tenantId, id, snapshot);
  return id;
}

/** appointment.booked → Wait 1 day → Condition (rule) → yes: Reminder / no: Skipped. */
function reminderJourney(rule: ConditionRule = { field: "appointment.status", operator: "equals", value: "scheduled" }, event = "appointment.booked"): string {
  const id = randomUUID();
  names.set(id, "Reminder");
  const snapshot: JourneySnapshot = {
    nodes: [
      node(`${id}:t`, "trigger", { event, filters: [] }),
      node(`${id}:w`, "action", { action: "wait", duration: 1, unit: "days" }),
      node(`${id}:c`, "condition", rule),
      node(`${id}:yes`, "action", { action: "create_task", title: "Reminder", notes: "", dueInDays: 0 }),
      node(`${id}:no`, "action", { action: "create_task", title: "Skipped", notes: "", dueInDays: 0 }),
    ],
    connections: [
      link(`${id}:t`, `${id}:w`),
      link(`${id}:w`, `${id}:c`),
      link(`${id}:c`, `${id}:yes`, "yes"),
      link(`${id}:c`, `${id}:no`, "no"),
    ],
  };
  store.saveJourney(tenant, id, snapshot);
  return id;
}

const task = (title: string) => ({ action: "create_task", title, notes: "", dueInDays: 1 });
const wait = { action: "wait", duration: 1, unit: "days" };
const rule = (field: string, value: string): ConditionRule => ({ field, operator: "equals", value });
const runs = (): MemoryRun[] => [...store.runs.values()];

async function drain(dispatch: (event: JourneyEvent) => Promise<unknown> = (event) => dispatchJourneyEvent(deps, event)) {
  return dispatchJourneyEvents(outbox, dispatch, { ...DEFAULT_OUTBOX_OPTIONS, budgetMs: 60_000 }, Date.now, () => {});
}

/** Delivers everything pending; the outcome of each journey per event, in order. */
async function deliver(): Promise<string[]> {
  const outcomes: string[] = [];
  await drain(async (event) => {
    const result = await dispatchJourneyEvent(deps, event);
    outcomes.push(...result.map((entry) => `${event.type}:${entry.result}`));
    return result;
  });
  return outcomes;
}

async function makeDue() {
  await db.query("update public.journey_events set next_attempt_at = now() - interval '1 second' where dispatched_at is null");
}

async function resumeAfterWait() {
  clock = new Date(clock.getTime() + 25 * 60 * 60_000);
  await resumeDueRuns(deps);
}

// ---------- State ----------

describe("appointment state", () => {
  it("new appointments and meetings start scheduled; other activities have no status", async () => {
    const lead = await newLead();
    const appointment = await newAppointment(lead);
    const meeting = await newAppointment(lead, { activityType: "meeting", start: "2026-10-07T15:00:00.000Z" });
    const [note] = await db.query<{ id: string }>(
      "insert into public.contact_activities (tenant_id, contact_id, activity_type, title) values ($1, $2, 'note', 'Called') returning id",
      [tenant, lead],
    );
    assert.equal((await appointmentRow(appointment)).appointment_status, "scheduled");
    assert.equal((await appointmentRow(meeting)).appointment_status, "scheduled");
    assert.equal((await appointmentRow(note.id)).appointment_status, null);
  });

  it("an appointment or meeting is never without a status, and only the four statuses exist", async () => {
    const lead = await newLead();
    const appointment = await newAppointment(lead);
    await db.query("update public.contact_activities set appointment_status = null where id = $1", [appointment]);
    assert.equal((await appointmentRow(appointment)).appointment_status, "scheduled", "a cleared status is scheduled again");
    await rejects(db.query("update public.contact_activities set appointment_status = 'attended' where id = $1", [appointment]), /appointment_status_check/);
    assert.ok((await setStatus(appointment, "cancelled")).ok);
    await rejects(db.query("update public.contact_activities set appointment_status = null where id = $1", [appointment]), /can't change status/);
    assert.equal((await appointmentRow(appointment)).appointment_status, "cancelled");
  });

  for (const status of ["cancelled", "completed", "no_show"] as const) {
    it(`scheduled → ${status}: the row stays, with its metadata and a ${status}_at stamp`, async () => {
      const lead = await newLead();
      const appointment = await newAppointment(lead, { metadata: { invite_sent_at: "2026-10-01T00:00:00.000Z", invite_lead_sent: false } });
      const result = await setStatus(appointment, status);
      assert.ok(result.ok, result.ok ? "" : result.error);
      const row = await appointmentRow(appointment);
      assert.equal(row.appointment_status, status);
      assert.equal(row.occurred_at.toISOString(), START);
      assert.equal(row.metadata?.invite_sent_at, "2026-10-01T00:00:00.000Z");
      assert.equal(row.metadata?.invite_lead_sent, false);
      assert.equal(row.metadata?.[`${status}_at`], AFTER_START.toISOString());
      assert.equal((await db.query("select id from public.contact_activities")).length, 1);
    });
  }

  it("a final status can't change again: the app refuses, and so does the database for members and the service role", async () => {
    const lead = await newLead();
    const appointment = await newAppointment(lead);
    assert.ok((await setStatus(appointment, "completed")).ok);
    const again = await setStatus(appointment, "no_show");
    assert.deepEqual(again, { ok: false, error: "This appointment was already marked completed." });
    for (const client of [member, service]) {
      for (const status of ["scheduled", "cancelled", "no_show"]) {
        const { error } = await client.from("contact_activities").update({ appointment_status: status }).eq("id", appointment);
        assert.match(error?.message ?? "", /is completed and can't change status/);
      }
    }
    await rejects(
      db.query("update public.contact_activities set appointment_status = 'scheduled' where id = $1", [appointment]),
      /can't change status/,
    );
    assert.equal((await appointmentRow(appointment)).appointment_status, "completed");
    assert.equal((await statusEvents()).length, 1);
  });

  it("a cancelled appointment can't be rescheduled; its other fields can still be edited", async () => {
    const lead = await newLead();
    const appointment = await newAppointment(lead);
    assert.ok((await setStatus(appointment, "cancelled")).ok);
    const { error } = await member.from("contact_activities").update({ occurred_at: "2026-10-08T15:00:00.000Z" }).eq("id", appointment);
    assert.match(error?.message ?? "", /is cancelled and can't be rescheduled/);
    const { error: noteError } = await member.from("contact_activities").update({ body: "Lead asked to cancel." }).eq("id", appointment);
    assert.equal(noteError, null);
    assert.equal((await appointmentRow(appointment)).occurred_at.toISOString(), START);
    assert.equal((await events("appointment.rescheduled")).length, 0);
  });

  it("completed and no-show can't be recorded before the appointment starts; cancelling can", async () => {
    const lead = await newLead();
    const appointment = await newAppointment(lead);
    const early = new Date("2026-10-06T14:59:00.000Z");
    assert.deepEqual(await setStatus(appointment, "completed", member, early), {
      ok: false,
      error: "An appointment can't be marked completed before it starts.",
    });
    assert.deepEqual(await setStatus(appointment, "no_show", member, early), {
      ok: false,
      error: "An appointment can't be marked as a no-show before it starts.",
    });
    assert.ok((await setStatus(appointment, "cancelled", member, early)).ok);
  });

  it("only appointments and meetings in the caller's workspace change status", async () => {
    const lead = await newLead();
    const [note] = await db.query<{ id: string }>(
      "insert into public.contact_activities (tenant_id, contact_id, activity_type, title) values ($1, $2, 'note', 'Called') returning id",
      [tenant, lead],
    );
    assert.deepEqual(await setStatus(note.id, "cancelled"), { ok: false, error: "That record is not an appointment." });
    const otherTenant = await newTenant();
    const theirs = await newAppointment(await newLead(otherTenant), { tenantId: otherTenant });
    assert.deepEqual(await setStatus(theirs, "cancelled"), { ok: false, error: "Appointment was not found." });
    assert.equal((await appointmentRow(theirs)).appointment_status, "scheduled");
  });

  it("a change applies only while the appointment is still scheduled (two people can't both change it)", async () => {
    const lead = await newLead();
    const appointment = await newAppointment(lead);
    // Someone else completes it between this request's read and its write.
    const { error } = await member
      .from("contact_activities")
      .update({ appointment_status: "completed" })
      .eq("id", appointment)
      .eq("appointment_status", "scheduled");
    assert.equal(error, null);
    const { data } = await member
      .from("contact_activities")
      .update({ appointment_status: "cancelled" })
      .eq("id", appointment)
      .eq("appointment_status", "scheduled")
      .select("id");
    assert.deepEqual(data, []);
    assert.equal((await appointmentRow(appointment)).appointment_status, "completed");
    assert.equal((await statusEvents()).length, 1);
  });
});

// ---------- Events ----------

describe("appointment state events", () => {
  for (const status of ["cancelled", "completed", "no_show"] as const) {
    it(`scheduled → ${status} records exactly one appointment.${status} with point-in-time values and a fresh occurrence id`, async () => {
      const lead = await newLead();
      const appointment = await newAppointment(lead);
      assert.ok((await setStatus(appointment, status)).ok);
      const rows = await statusEvents();
      assert.equal(rows.length, 1);
      const [event] = rows;
      assert.equal(event.event_type, `appointment.${status}`);
      assert.equal(event.tenant_id, tenant);
      assert.equal(event.contact_id, lead);
      assert.equal(event.entity_type, "appointment");
      assert.equal(event.entity_id, appointment);
      assert.match(event.source_id, UUID);
      assert.notEqual(event.source_id, appointment);
      assert.equal(event.origin, null);
      assert.equal(event.origin_run_id, null);
      assert.deepEqual(event.payload, {
        appointment_id: appointment,
        contact_id: lead,
        opportunity_id: null,
        from_status: "scheduled",
        to_status: status,
        start: START,
        end: END,
        changed_by: "team",
      });
    });
  }

  it("carries the opportunity the appointment is linked to, and a null end when there is none", async () => {
    const lead = await newLead();
    const [opp] = await db.query<{ id: string }>("insert into public.opportunities (tenant_id, contact_id) values ($1, $2) returning id", [tenant, lead]);
    const appointment = await newAppointment(lead, { opportunityId: opp.id, end: null });
    assert.ok((await setStatus(appointment, "cancelled")).ok);
    const [event] = await events("appointment.cancelled");
    assert.equal(event.payload.opportunity_id, opp.id);
    assert.equal(event.payload.end, null);
  });

  it("writing the same status, editing other fields, or rescheduling records no status event", async () => {
    const lead = await newLead();
    const appointment = await newAppointment(lead);
    await member.from("contact_activities").update({ appointment_status: "scheduled" }).eq("id", appointment);
    await member.from("contact_activities").update({ title: "Consult (moved)", body: "Notes" }).eq("id", appointment);
    await withJourneyEventHeaders(
      service.from("contact_activities").update({ occurred_at: "2026-10-07T15:00:00.000Z" }).eq("id", appointment),
      appointmentRescheduledHeaders("team"),
    );
    assert.deepEqual((await events()).map((row) => row.event_type), ["appointment.booked", "appointment.rescheduled"]);
    assert.ok((await setStatus(appointment, "completed", member, new Date("2026-10-07T16:00:00.000Z"))).ok);
    // A rejected second change records nothing either.
    await member.from("contact_activities").update({ appointment_status: "completed" }).eq("id", appointment);
    assert.equal((await statusEvents()).length, 1);
  });

  it("each appointment's transition is its own occurrence", async () => {
    const lead = await newLead();
    const first = await newAppointment(lead);
    const second = await newAppointment(lead, { start: "2026-10-06T16:00:00.000Z", end: null });
    assert.ok((await setStatus(first, "no_show", member, new Date("2026-10-06T17:00:00.000Z"))).ok);
    assert.ok((await setStatus(second, "no_show", member, new Date("2026-10-06T17:00:00.000Z"))).ok);
    const rows = await statusEvents();
    assert.deepEqual(rows.map((row) => row.entity_id), [first, second]);
    assert.notEqual(rows[0].source_id, rows[1].source_id);
  });

  it("changed_by is 'team' for signed-in users whatever headers say, and 'system' for the service role and role-less SQL", async () => {
    const lead = await newLead();
    const viaMember = await newAppointment(lead, { start: "2026-10-06T10:00:00.000Z" });
    const viaService = await newAppointment(lead, { start: "2026-10-06T11:00:00.000Z" });
    const viaSql = await newAppointment(lead, { start: "2026-10-06T12:00:00.000Z" });
    const viaForgedClaims = await newAppointment(lead, { start: "2026-10-06T13:00:00.000Z" });
    const forged = { "x-reos-origin": "journey", "x-reos-changed-by": "team", role: "authenticated" };
    await withJourneyEventHeaders(member.from("contact_activities").update({ appointment_status: "cancelled" }).eq("id", viaMember), forged);
    await withJourneyEventHeaders(service.from("contact_activities").update({ appointment_status: "cancelled" }).eq("id", viaService), forged);
    await writeAs(null, "update public.contact_activities set appointment_status = 'cancelled' where id = $1", [viaSql], forged);
    await writeAs({ role: "service_role" }, "update public.contact_activities set appointment_status = 'cancelled' where id = $1", [viaForgedClaims], forged);
    const byAppointment = new Map((await statusEvents()).map((row) => [row.entity_id, row.payload.changed_by]));
    assert.deepEqual(
      [viaMember, viaService, viaSql, viaForgedClaims].map((id) => byAppointment.get(id)),
      ["team", "system", "system", "system"],
    );
  });

  it("tenant isolation: an appointment whose contact is in another workspace records nothing", async () => {
    const otherTenant = await newTenant();
    const theirs = await newLead(otherTenant);
    const [row] = await db.query<{ id: string }>(
      `insert into public.contact_activities (tenant_id, contact_id, activity_type, title, occurred_at)
       values ($1, $2, 'appointment', 'Consult', $3) returning id`,
      [tenant, theirs, START],
    );
    await db.query("update public.contact_activities set appointment_status = 'cancelled' where id = $1", [row.id]);
    assert.equal((await statusEvents()).length, 0);
  });

  it("no forgery: signed-in and anon clients can't write journey events, call the capture functions, or (anon) change a status", async () => {
    const lead = await newLead();
    const appointment = await newAppointment(lead);
    const anon = db.client("anon");
    for (const client of [member, anon]) {
      const { error } = await client.from("journey_events").insert({
        tenant_id: tenant, contact_id: lead, event_type: "appointment.cancelled", source_id: "forged", entity_type: "appointment", entity_id: appointment,
      });
      assert.ok(error, "insert into journey_events is refused");
      const { error: rpcError } = await client.rpc("record_journey_transition", {
        p_tenant_id: tenant, p_contact_id: lead, p_event_type: "appointment.cancelled", p_entity_type: "appointment",
        p_entity_id: appointment, p_payload: {}, p_origin: null, p_origin_run_id: null,
      });
      assert.ok(rpcError, "record_journey_transition is refused");
      const { error: captureError } = await client.rpc("capture_appointment_status_changed", {});
      assert.ok(captureError, "the capture function is refused");
    }
    const { error: anonUpdate } = await anon.from("contact_activities").update({ appointment_status: "cancelled" }).eq("id", appointment);
    assert.ok(anonUpdate, "anon can't change an appointment");
    assert.equal((await appointmentRow(appointment)).appointment_status, "scheduled");
    assert.equal((await statusEvents()).length, 0);
  });

  it("the three events are durable journey events without journey lineage", () => {
    for (const type of STATUS_EVENTS) {
      assert.ok((JOURNEY_EVENT_TYPES as readonly string[]).includes(type));
      assert.equal(LINEAGE_EVENT_TYPES.has(type), false);
      assert.ok(isImplementedTriggerEvent(type));
    }
    assert.ok(isImplementedTriggerEvent("appointment.rescheduled"), "rescheduled stays its own event");
  });
});

// ---------- Delivery ----------

describe("appointment state event delivery", () => {
  it("starts cancellation, completion, and no-show journeys, each once, keyed by the occurrence without a version", async () => {
    const cancelled = journey("On cancel", "appointment.cancelled", [], [task("Rebook")]);
    journey("On complete", "appointment.completed", [rule("trigger.changed_by", "team")], [task("Send agreement")]);
    journey("On no-show", "appointment.no_show", [rule("trigger.to_status", "no_show")], [task("Call lead")]);
    const lead = await newLead();
    const a = await newAppointment(lead, { start: "2026-10-06T10:00:00.000Z" });
    const b = await newAppointment(await newLead(), { start: "2026-10-06T11:00:00.000Z" });
    const c = await newAppointment(await newLead(), { start: "2026-10-06T12:00:00.000Z" });
    assert.ok((await setStatus(a, "cancelled")).ok);
    assert.ok((await setStatus(b, "completed", member, new Date("2026-10-06T13:00:00.000Z"))).ok);
    assert.ok((await setStatus(c, "no_show", member, new Date("2026-10-06T13:00:00.000Z"))).ok);
    const outcomes = await deliver();
    assert.deepEqual(outcomes.filter((entry) => !entry.startsWith("appointment.booked")), [
      "appointment.cancelled:started",
      "appointment.completed:started",
      "appointment.no_show:started",
    ]);
    assert.deepEqual(tasks.sort(), ["On cancel:Rebook", "On complete:Send agreement", "On no-show:Call lead"]);
    const [row] = await events("appointment.cancelled");
    const run = runs().find((entry) => entry.journeyId === cancelled)!;
    assert.equal(run.idempotencyKey, `appointment.cancelled:${row.source_id}:${cancelled}`);
    assert.equal(idempotencyKey({ type: "appointment.cancelled", sourceId: "x" }, cancelled, 4), `appointment.cancelled:x:${cancelled}`);
    assert.equal(run.entityType, "appointment");
    assert.equal(run.entityId, a);
    assert.deepEqual(run.triggerPayload, row.payload);
  });

  it("redelivery of the same occurrence starts nothing new", async () => {
    journey("On cancel", "appointment.cancelled", [], [task("Rebook")]);
    const appointment = await newAppointment(await newLead());
    assert.ok((await setStatus(appointment, "cancelled")).ok);
    assert.deepEqual(await deliver(), ["appointment.cancelled:started"]);
    await db.query("update public.journey_events set dispatched_at = null where event_type = 'appointment.cancelled'");
    assert.deepEqual(await deliver(), ["appointment.cancelled:duplicate"]);
    assert.equal(runs().length, 1);
    assert.deepEqual(tasks, ["On cancel:Rebook"]);
  });

  it("a failed delivery is retried with backoff and starts exactly one run", async () => {
    journey("On no-show", "appointment.no_show", [], [task("Call lead")]);
    const appointment = await newAppointment(await newLead());
    await drain();
    assert.ok((await setStatus(appointment, "no_show")).ok);
    const failed = await drain(async () => {
      throw new Error("store unavailable");
    });
    assert.deepEqual(failed, { claimed: 1, delivered: 0, depthLimited: 0, failed: 1, permanentlyFailed: 0 });
    const [row] = await events("appointment.no_show");
    assert.equal(row.dispatched_at, null);
    assert.equal((await drain()).claimed, 0, "not due yet");
    await makeDue();
    assert.deepEqual(await deliver(), ["appointment.no_show:started"]);
    assert.equal(runs().length, 1);
  });

  it("cron recovery: with no fast path the drain delivers it, and a claim whose completion was lost is redelivered after the lease as a duplicate", async () => {
    journey("On complete", "appointment.completed", [], [task("Send agreement")]);
    const appointment = await newAppointment(await newLead());
    await drain();
    assert.ok((await setStatus(appointment, "completed")).ok);
    const lostComplete: JourneyEventOutbox = { ...outbox, complete: async () => {} };
    await dispatchJourneyEvents(lostComplete, (event) => dispatchJourneyEvent(deps, event), { ...DEFAULT_OUTBOX_OPTIONS, budgetMs: 60_000 }, Date.now, () => {});
    assert.equal(runs().length, 1);
    assert.equal((await drain()).claimed, 0, "still leased");
    await db.query("update public.journey_events set locked_until = now() - interval '1 second'");
    assert.deepEqual(await deliver(), ["appointment.completed:duplicate"]);
    assert.ok((await events()).every((row) => row.dispatched_at));
    assert.deepEqual(tasks, ["On complete:Send agreement"]);
  });

  it("is dispatched only to its own workspace's journeys", async () => {
    const otherTenant = await newTenant();
    journey("Theirs", "appointment.cancelled", [], [task("Rebook")], otherTenant);
    const appointment = await newAppointment(await newLead());
    assert.ok((await setStatus(appointment, "cancelled")).ok);
    assert.deepEqual(await deliver(), []);
    assert.equal(runs().length, 0);
  });

  it("already_active is unchanged: a second completion while the journey is waiting for the same contact is dropped", async () => {
    journey("Follow-up", "appointment.completed", [], [wait, task("Check in")]);
    const lead = await newLead();
    const first = await newAppointment(lead, { start: "2026-10-06T10:00:00.000Z" });
    const second = await newAppointment(lead, { start: "2026-10-06T11:00:00.000Z" });
    assert.ok((await setStatus(first, "completed", member, new Date("2026-10-06T12:00:00.000Z"))).ok);
    assert.deepEqual(await deliver(), ["appointment.completed:started"]);
    assert.ok((await setStatus(second, "completed", member, new Date("2026-10-06T12:00:00.000Z"))).ok);
    assert.deepEqual(await deliver(), ["appointment.completed:already_active"]);
    assert.equal(runs().length, 1);
    assert.ok((await events()).every((row) => row.dispatched_at));
  });
});

// ---------- Journeys that check the appointment ----------

describe("journey condition on the appointment's current status", () => {
  it("is a condition field for appointment-triggered journeys, validated like the other enums", () => {
    const field = CONDITION_FIELDS["appointment.status"];
    assert.deepEqual(field.options, ["scheduled", "cancelled", "completed", "no_show"]);
    assert.ok(field.events?.includes("appointment.booked"));
    assert.ok(field.events?.includes("appointment.rescheduled"));
    assert.deepEqual(validateNodeConfig("condition", rule("appointment.status", "scheduled"), "strict").errors, []);
    assert.ok(validateNodeConfig("condition", rule("appointment.state", "scheduled"), "strict").errors.length > 0, "no other appointment path");
    assert.deepEqual(CONDITION_FIELDS["trigger.changed_by"].options, ["team", "system"]);
    for (const type of STATUS_EVENTS) {
      assert.deepEqual(validateNodeConfig("trigger", { event: type, filters: [] }, "strict").errors, []);
    }
  });

  it("a reminder waiting after booking still goes out while the appointment is scheduled", async () => {
    reminderJourney();
    await newAppointment(await newLead());
    assert.deepEqual(await deliver(), ["appointment.booked:started"]);
    assert.equal(runs()[0].status, "waiting");
    await resumeAfterWait();
    assert.deepEqual(tasks, ["Reminder:Reminder"]);
  });

  for (const status of ["cancelled", "completed", "no_show"] as const) {
    it(`no reminder after the appointment is ${status} while the journey waits; the run itself is not cancelled or woken`, async () => {
      reminderJourney();
      const appointment = await newAppointment(await newLead());
      await deliver();
      const run = runs()[0];
      assert.equal(run.status, "waiting");
      const resumeAt = run.resumeAt;
      assert.ok((await setStatus(appointment, status)).ok);
      await deliver();
      assert.equal(store.runs.get(run.id)!.status, "waiting", "not cancelled");
      assert.equal(store.runs.get(run.id)!.resumeAt, resumeAt, "not woken");
      await resumeAfterWait();
      assert.deepEqual(tasks, ["Reminder:Skipped"]);
      assert.equal(store.runs.get(run.id)!.status, "completed");
    });
  }

  it("a rescheduled appointment is still scheduled: the reminder goes out, and rescheduled journeys start as before", async () => {
    reminderJourney();
    journey("On reschedule", "appointment.rescheduled", [rule("trigger.rescheduled_by", "team")], [task("Confirm new time")]);
    const appointment = await newAppointment(await newLead());
    await deliver();
    await withJourneyEventHeaders(
      service.from("contact_activities").update({ occurred_at: "2026-10-07T15:00:00.000Z", ends_at: "2026-10-07T15:30:00.000Z" }).eq("id", appointment),
      appointmentRescheduledHeaders("team"),
    );
    assert.deepEqual(await deliver(), ["appointment.rescheduled:started"]);
    await resumeAfterWait();
    assert.deepEqual(tasks.sort(), ["On reschedule:Confirm new time", "Reminder:Reminder"]);
    assert.equal((await appointmentRow(appointment)).appointment_status, "scheduled");
  });

  it("checks the run's own appointment, not another appointment of the same lead", async () => {
    reminderJourney();
    const lead = await newLead();
    await newAppointment(lead);
    await deliver();
    const other = await newAppointment(lead, { start: "2026-10-08T15:00:00.000Z" });
    assert.ok((await setStatus(other, "cancelled")).ok);
    await resumeAfterWait();
    assert.ok(tasks.includes("Reminder:Reminder"));
  });

  it("an appointment deleted while the run waits has no status, so the reminder doesn't go out", async () => {
    reminderJourney();
    const appointment = await newAppointment(await newLead());
    await deliver();
    await db.query("delete from public.contact_activities where id = $1", [appointment]);
    await resumeAfterWait();
    assert.deepEqual(tasks, ["Reminder:Skipped"]);
  });

  it("a cancellation journey can read the appointment's status at the time it runs", async () => {
    reminderJourney(rule("appointment.status", "cancelled"), "appointment.cancelled");
    const appointment = await newAppointment(await newLead());
    assert.ok((await setStatus(appointment, "cancelled")).ok);
    await deliver();
    await resumeAfterWait();
    assert.deepEqual(tasks, ["Reminder:Reminder"]);
  });

  it("a trigger filter reads the status when the event is delivered", async () => {
    journey("Booked, still on", "appointment.booked", [rule("appointment.status", "scheduled")], [task("Prep")]);
    journey("Cancelled", "appointment.cancelled", [rule("appointment.status", "cancelled")], [task("Rebook")]);
    const kept = await newAppointment(await newLead());
    const dropped = await newAppointment(await newLead());
    // Cancelled before its booking event was delivered.
    assert.ok((await setStatus(dropped, "cancelled")).ok);
    const outcomes = await deliver();
    assert.deepEqual(outcomes, [
      "appointment.booked:started",
      "appointment.booked:filtered",
      "appointment.cancelled:started",
    ]);
    assert.deepEqual(tasks.sort(), ["Booked, still on:Prep", "Cancelled:Rebook"]);
    assert.equal(runs().find((run) => run.triggerEvent === "appointment.booked")?.entityId, kept);
  });

  it("only the run's contact's appointment is read", async () => {
    reminderJourney(rule("appointment.status", "scheduled"), "appointment.no_show");
    const lead = await newLead();
    const someoneElses = await newAppointment(await newLead());
    // An event naming another contact's appointment (no producer writes one; the store must not follow it).
    await db.query(
      `insert into public.journey_events (tenant_id, contact_id, event_type, source_id, entity_type, entity_id, payload)
       values ($1, $2, 'appointment.no_show', $3, 'appointment', $4, '{}')`,
      [tenant, lead, randomUUID(), someoneElses],
    );
    await deliver();
    await resumeAfterWait();
    assert.deepEqual(tasks, ["Reminder:Skipped"]);
  });

  it("the Supabase store keeps the run's appointment, so a resumed run reads that appointment", async () => {
    const supabaseStore = createSupabaseJourneyStore(service);
    const lead = await newLead();
    const appointment = await newAppointment(lead);
    const result = await supabaseStore.createRun({
      tenantId: tenant,
      journeyId: randomUUID(),
      journeyVersion: 1,
      contactId: lead,
      entityType: "appointment",
      entityId: appointment,
      currentNodeId: "w",
      triggerEvent: "appointment.booked",
      triggerPayload: {},
      idempotencyKey: randomUUID(),
      resumeAt: new Date().toISOString(),
    });
    assert.ok(result.run);
    assert.equal(result.run.entityType, "appointment");
    assert.equal(result.run.entityId, appointment);
    assert.equal(appointmentIdOf(result.run), appointment);
    const entities = await supabaseStore.loadEntities(tenant, lead, appointmentIdOf(result.run));
    assert.deepEqual(entities.appointment, { id: appointment, status: "scheduled", start: START, end: END });
  });

  it("outside appointment-triggered runs the field has no value", async () => {
    const id = randomUUID();
    names.set(id, "Manual");
    store.saveJourney(tenant, id, {
      nodes: [
        node(`${id}:t`, "trigger", { event: "manual", filters: [] }),
        node(`${id}:c`, "condition", rule("appointment.status", "scheduled")),
        node(`${id}:yes`, "action", task("Yes")),
        node(`${id}:no`, "action", task("No")),
      ],
      connections: [link(`${id}:t`, `${id}:c`), link(`${id}:c`, `${id}:yes`, "yes"), link(`${id}:c`, `${id}:no`, "no")],
    });
    const lead = await newLead();
    await newAppointment(lead);
    await dispatchJourneyEvent(deps, {
      tenantId: tenant, type: "manual", sourceId: randomUUID(), contactId: lead, entityType: "contact", entityId: lead, payload: {},
    });
    assert.deepEqual(tasks, ["Manual:No"]);
  });
});
