/**
 * Appointment-relative Wait (D.2) against the real appointment rows: booked and
 * rescheduled through supabase-js on PGlite (the real 060/062 triggers record
 * the events), delivered by the real outbox into dispatchJourneyEvent, and the
 * appointment read through the real Supabase store's loadEntities. Runs live in
 * the in-memory journey store. Also checks that the Supabase store's snapshot
 * parsing keeps every Wait shape as it is.
 * live-actions-test-env.ts must be the first import; it fails closed on any
 * other network access.
 */

import { attachTestDb, blockedRequests } from "./live-actions-test-env.ts";

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, afterEach, before, beforeEach, describe, it } from "node:test";
import type { SupabaseClient } from "@supabase/supabase-js";
import { setAppointmentStatus } from "../../calendar/appointment-status.ts";
import { appointmentBookedHeaders, appointmentRescheduledHeaders, withJourneyEventHeaders } from "../journey-event-headers.ts";
import type { JourneyAIExecutor } from "./ai.ts";
import { parseWait, type ConditionRule } from "./contracts.ts";
import { APPOINTMENT_WAIT_RECHECK_MS, dispatchJourneyEvent, resumeDueRuns, type ActionExecutor, type EngineDeps, type JourneyEvent } from "./engine.ts";
import type { JourneySnapshot, SnapshotNode } from "./graph.ts";
import { createSupabaseJourneyEventOutbox, dispatchJourneyEvents, type JourneyEventOutbox } from "./journey-event-outbox.ts";
import { createJourneyEventsTestDb } from "./journey-events-test-db.ts";
import { DEFAULT_OUTBOX_OPTIONS } from "./lead-status-outbox.ts";
import type { TestDb } from "./lead-status-test-db.ts";
import { MemoryJourneyStore, type MemoryRun } from "./memory-store.ts";

// After the test environment: the store resolves the app's `@/` imports.
const { createSupabaseJourneyStore, parseSnapshot } = await import("./supabase-store.ts");

/** The rest of the lead and run columns the Supabase store reads (loadEntities). */
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
  add column current_node_id text,
  add column context jsonb not null default '{}'::jsonb,
  add column error text,
  add column resume_at timestamptz,
  add column started_at timestamptz not null default now();
`;

const USER = randomUUID();
const MINUTE = 60_000;
// 2026-10-06 is a Tuesday.
const TUE_2PM = "2026-10-06T14:00:00.000Z";
const WED_2PM = "2026-10-07T14:00:00.000Z";
const THU_2PM = "2026-10-08T14:00:00.000Z";
const FRI_2PM = "2026-10-09T14:00:00.000Z";

let db: TestDb;
let service: SupabaseClient;
let member: SupabaseClient;
let tenant: string;
let store: MemoryJourneyStore;
let deps: EngineDeps;
let outbox: JourneyEventOutbox;
let clock: Date;
let tasks: Array<{ title: string; at: string; runId: string }>;

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
  tasks = [];
  clock = new Date(TUE_2PM);
  store = new MemoryJourneyStore();
  store.clock = () => new Date(clock);
  const supabaseStore = createSupabaseJourneyStore(service);
  store.loadEntities = (tenantId, contactId, appointmentId) => supabaseStore.loadEntities(tenantId, contactId, appointmentId);
  const actions: ActionExecutor = {
    async execute(action, input) {
      if (action.action === "create_task") tasks.push({ title: action.title, at: clock.toISOString(), runId: input.runId });
      return { status: "completed", output: {} };
    },
  };
  deps = { store, actions, ai, now: () => new Date(clock) };
});

afterEach(() => {
  assert.deepEqual(blockedRequests, [], "no request may leave the test environment");
});

// ---------- Helpers ----------

function node(id: string, type: SnapshotNode["type"], config: Record<string, unknown>): SnapshotNode {
  return { id, type, name: id, description: "", config };
}

function link(source: string, target: string, sourceHandle: string | null = null) {
  return { id: `${source}->${target}`, sourceNodeId: source, targetNodeId: target, sourceHandle, targetHandle: null };
}

const until = (offsetMinutes: number) => ({ action: "wait", until: { field: "appointment.start", offsetMinutes } });
const task = (title: string) => ({ action: "create_task", title, notes: "", dueInDays: 0 });

/** Appointment triggers → Wait until the appointment → Condition (status is scheduled) → yes: "Remind" / no: "Skip". */
function reminderJourney(offsetMinutes: number, events = ["appointment.booked", "appointment.rescheduled"]): string {
  const id = randomUUID();
  const rule: ConditionRule = { field: "appointment.status", operator: "equals", value: "scheduled" };
  const triggers = events.map((event, index) => node(`${id}:t${index}`, "trigger", { event, filters: [] }));
  store.saveJourney(tenant, id, {
    nodes: [
      ...triggers,
      node(`${id}:w`, "action", until(offsetMinutes)),
      node(`${id}:c`, "condition", rule as unknown as Record<string, unknown>),
      node(`${id}:yes`, "action", task("Remind")),
      node(`${id}:no`, "action", task("Skip")),
    ],
    connections: [
      ...triggers.map((trigger) => link(trigger.id, `${id}:w`)),
      link(`${id}:w`, `${id}:c`),
      link(`${id}:c`, `${id}:yes`, "yes"),
      link(`${id}:c`, `${id}:no`, "no"),
    ],
  });
  return id;
}

async function newLead(tenantId = tenant): Promise<string> {
  const [row] = await db.query<{ id: string }>("insert into public.contacts (tenant_id) values ($1) returning id", [tenantId]);
  return row.id;
}

/** An appointment as the booking paths insert it, recording appointment.booked. */
async function newAppointment(contactId: string, start: string): Promise<string> {
  const end = new Date(new Date(start).getTime() + 30 * MINUTE).toISOString();
  const { data, error } = await withJourneyEventHeaders(
    service
      .from("contact_activities")
      .insert({ tenant_id: tenant, contact_id: contactId, activity_type: "appointment", title: "Consult", occurred_at: start, ends_at: end, source: "concierge" })
      .select("id")
      .single(),
    appointmentBookedHeaders("agent"),
  );
  assert.equal(error, null);
  return data!.id;
}

/** Moves the appointment the way the calendar does, recording appointment.rescheduled. */
async function reschedule(appointmentId: string, start: string) {
  const end = new Date(new Date(start).getTime() + 30 * MINUTE).toISOString();
  const { error } = await withJourneyEventHeaders(
    service.from("contact_activities").update({ occurred_at: start, ends_at: end }).eq("id", appointmentId),
    appointmentRescheduledHeaders("team"),
  );
  assert.equal(error, null);
}

/** Delivers everything pending; `<event>:<result>` per journey, in order. */
async function deliver(): Promise<string[]> {
  const outcomes: string[] = [];
  await dispatchJourneyEvents(
    outbox,
    async (event: JourneyEvent) => {
      const result = await dispatchJourneyEvent(deps, event);
      outcomes.push(...result.map((entry) => `${event.type}:${entry.result}`));
      return result;
    },
    { ...DEFAULT_OUTBOX_OPTIONS, budgetMs: 60_000 },
    Date.now,
    () => {},
  );
  return outcomes;
}

/** The worker: claims due runs once a minute until `iso`. Fifteen-minute strides while nothing can be due, to keep PGlite reads down. */
async function workUntil(iso: string) {
  const end = new Date(iso).getTime();
  while (clock.getTime() < end) {
    const due = [...store.runs.values()].filter((run) => run.status === "waiting" && run.resumeAt).map((run) => new Date(run.resumeAt!).getTime());
    const next = Math.min(end, ...due, clock.getTime() + APPOINTMENT_WAIT_RECHECK_MS);
    clock = new Date(Math.max(next, clock.getTime() + MINUTE));
    if (clock.getTime() > end) clock = new Date(end);
    await resumeDueRuns(deps);
  }
}

const runs = (): MemoryRun[] => [...store.runs.values()];
const waitOutput = (runId: string) => store.stepsFor(runId).find((step) => "until" in step.input)?.output;
const at = (iso: string) => new Date(iso).toISOString();

// ---------- Real appointments ----------

describe("appointment Wait on real appointment rows", () => {
  it("Tuesday booking for Thursday 2 PM, one day before: fires Wednesday 2 PM, read from the stored start", async () => {
    reminderJourney(-1440);
    await newAppointment(await newLead(), THU_2PM);
    assert.deepEqual(await deliver(), ["appointment.booked:started"]);
    const [run] = runs();
    assert.equal(run.status, "waiting");
    assert.equal(waitOutput(run.id)?.target_at, at(WED_2PM));
    await workUntil("2026-10-07T13:59:00.000Z");
    assert.deepEqual(tasks, []);
    await workUntil(WED_2PM);
    assert.deepEqual(tasks.map((entry) => [entry.title, entry.at]), [["Remind", at(WED_2PM)]]);
    assert.deepEqual(waitOutput(run.id), { target_at: at(WED_2PM), resumed_at: at(WED_2PM), late: false });
  });

  it("rescheduled later through the calendar write: the reschedule event is already_active, and the reminder moves to the new time", async () => {
    reminderJourney(-1440);
    const appointment = await newAppointment(await newLead(), THU_2PM);
    await deliver();
    await workUntil("2026-10-06T18:00:00.000Z");
    await reschedule(appointment, FRI_2PM);
    assert.deepEqual(await deliver(), ["appointment.rescheduled:already_active"]);
    await workUntil("2026-10-08T13:59:00.000Z");
    assert.deepEqual(tasks, [], "the old Wednesday target passed without firing");
    await workUntil(THU_2PM);
    assert.deepEqual(tasks.map((entry) => entry.at), [at(THU_2PM)]);
  });

  it("rescheduled earlier: the recheck reads the new start within 15 minutes and fires at the new target", async () => {
    reminderJourney(-60);
    const appointment = await newAppointment(await newLead(), FRI_2PM);
    await deliver();
    const [run] = runs();
    await workUntil("2026-10-07T09:00:00.000Z");
    await reschedule(appointment, "2026-10-07T12:00:00.000Z");
    await deliver();
    await workUntil("2026-10-07T09:15:00.000Z");
    assert.equal(waitOutput(run.id)?.target_at, "2026-10-07T11:00:00.000Z");
    await workUntil("2026-10-07T12:00:00.000Z");
    assert.deepEqual(tasks.map((entry) => entry.at), ["2026-10-07T11:00:00.000Z"]);
  });

  it("two appointments of one lead: each run reads its own row, not the lead's latest", async () => {
    reminderJourney(-60, ["appointment.booked"]);
    const lead = await newLead();
    const thursday = await newAppointment(lead, THU_2PM);
    const wednesday = await newAppointment(lead, WED_2PM);
    assert.deepEqual(await deliver(), ["appointment.booked:started", "appointment.booked:started"]);
    await workUntil("2026-10-08T15:00:00.000Z");
    const byAppointment = new Map(runs().map((run) => [run.id, run.entityId]));
    assert.deepEqual(
      tasks.map((entry) => [byAppointment.get(entry.runId), entry.at]).sort(),
      [[wednesday, "2026-10-07T13:00:00.000Z"], [thursday, "2026-10-08T13:00:00.000Z"]].sort(),
    );
  });

  it("cancelled through the real status change while waiting: still waits for the target, then the status condition skips", async () => {
    reminderJourney(-1440, ["appointment.booked"]);
    const appointment = await newAppointment(await newLead(), THU_2PM);
    await deliver();
    const [run] = runs();
    const cancelled = await setAppointmentStatus(member, { tenantId: tenant, appointmentId: appointment, status: "cancelled", now: new Date("2026-10-06T15:00:00.000Z") });
    assert.ok(cancelled.ok);
    await workUntil("2026-10-07T13:59:00.000Z");
    assert.equal(store.runs.get(run.id)!.status, "waiting");
    await workUntil(WED_2PM);
    assert.deepEqual(tasks.map((entry) => entry.title), ["Skip"]);
  });

  it("an appointment row deleted while waiting: skipped as appointment_not_found at the next recheck", async () => {
    reminderJourney(-1440, ["appointment.booked"]);
    const appointment = await newAppointment(await newLead(), THU_2PM);
    await deliver();
    const [run] = runs();
    await db.query("delete from public.contact_activities where id = $1", [appointment]);
    await workUntil("2026-10-06T14:30:00.000Z");
    assert.deepEqual(waitOutput(run.id), { skipped_reason: "appointment_not_found" });
    assert.equal(store.runs.get(run.id)!.status, "completed");
  });
});

// ---------- Snapshot parsing in the Supabase store ----------

describe("published snapshots keep every Wait shape", () => {
  const snapshotWith = (config: Record<string, unknown>) =>
    parseSnapshot({
      nodes: [
        { id: "t", type: "trigger", name: "t", description: "", config: { event: "appointment.booked", filters: [] } },
        { id: "w", type: "action", name: "w", description: "", config },
      ],
      connections: [{ id: "t->w", sourceNodeId: "t", targetNodeId: "w", sourceHandle: null, targetHandle: null }],
    })!.nodes.find((entry) => entry.id === "w")!.config;

  it("legacy duration Waits read exactly as before", () => {
    assert.deepEqual(snapshotWith({ action: "wait", duration: 2, unit: "hours" }), { action: "wait", duration: 2, unit: "hours" });
    assert.deepEqual(snapshotWith({ action: "wait", duration: "3", unit: "days" }), { action: "wait", duration: 3, unit: "days" });
  });

  it("appointment Waits read as written", () => {
    assert.deepEqual(snapshotWith(until(-1440)), until(-1440));
    assert.deepEqual(snapshotWith(until(0)), until(0));
  });

  it("invalid or ambiguous Waits stay invalid; none becomes a duration Wait", () => {
    for (const config of [
      { action: "wait", until: { field: "appointment.end", offsetMinutes: 0 } },
      { action: "wait", until: { field: "appointment.start", offsetMinutes: "60" } },
      { action: "wait", until: { field: "appointment.start", offsetMinutes: -60 }, duration: 1, unit: "days" },
      { action: "wait", until: null },
      { action: "wait" },
    ]) {
      assert.equal(parseWait(snapshotWith(config)).kind, "invalid", JSON.stringify(config));
    }
  });
});
