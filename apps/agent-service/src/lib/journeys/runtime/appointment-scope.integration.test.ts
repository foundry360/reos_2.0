/**
 * Appointment-scoped active runs (migration 063): a run started by an
 * appointment event competes only with active runs of the same journey for the
 * same appointment; every other run (manual, journey.started, AI starts,
 * contact/message/task events) competes with the contact's other contact-scoped
 * runs of the journey, as before.
 *
 * Engine behaviour runs on MemoryJourneyStore. The database rule runs on PGlite
 * with the real migrations 056 + 063 and the real Supabase store, and a parity
 * matrix checks the two stores give the same answers.
 * live-actions-test-env.ts must be the first import (supabase-store.ts uses @/ imports).
 */

import { attachTestDb, blockedRequests } from "./live-actions-test-env.ts";

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { after, before, beforeEach, describe, it } from "node:test";
import type { JourneyAIExecutor } from "./ai.ts";
import type { ConditionRule } from "./contracts.ts";
import {
  dispatchJourneyEvent,
  JourneyStepError,
  resumeDueRuns,
  type ActionExecutor,
  type EngineDeps,
  type JourneyEvent,
  type JourneyRuntimeStore,
  type NewRun,
} from "./engine.ts";
import type { JourneySnapshot, SnapshotNode } from "./graph.ts";
import { createTestDb, type TestDb } from "./lead-status-test-db.ts";
import { MemoryJourneyStore, type MemoryRun } from "./memory-store.ts";
import { retryJourneyRun, type RunRetryLookups } from "./run-retry.ts";
import { inRunScope, runScopeOf } from "./run-insert-conflict.ts";

const TENANT = randomUUID();
const LEAD = randomUUID();
const START = new Date("2026-10-06T12:00:00.000Z");
const DAY = 24 * 60 * 60_000;

let store: MemoryJourneyStore;
let deps: EngineDeps;
let clock: Date;
let tasks: Array<{ title: string; runId: string }>;
let failNext: string | null;

const ai: JourneyAIExecutor = { execute: async () => ({ success: true, output: {}, text: "" }) };

beforeEach(() => {
  clock = START;
  store = new MemoryJourneyStore();
  store.clock = () => clock;
  store.contacts.set(LEAD, { tenantId: TENANT, lead: { id: LEAD, first_name: "Ana" } });
  tasks = [];
  failNext = null;
  const actions: ActionExecutor = {
    execute: async (action, input) => {
      if (action.action !== "create_task") return { status: "completed", output: {} };
      if (failNext === action.title) {
        failNext = null;
        throw new JourneyStepError("The task list is unavailable.", "config");
      }
      tasks.push({ title: action.title, runId: input.runId });
      return { status: "completed", output: { title: action.title } };
    },
  };
  deps = { store, actions, ai, now: () => clock };
});

// ---------- Helpers ----------

function node(id: string, type: SnapshotNode["type"], config: Record<string, unknown>, name = id): SnapshotNode {
  return { id, type, name, description: "", config };
}

function link(source: string, target: string, sourceHandle: string | null = null) {
  return { id: `${source}->${target}`, sourceNodeId: source, targetNodeId: target, sourceHandle, targetHandle: null };
}

/** Triggers (one per event) → the steps in order. */
function journey(events: string[], steps: Record<string, unknown>[], id: string = randomUUID()): string {
  const triggers = events.map((event, index) => node(`${id}:t${index}`, "trigger", { event, filters: [] }));
  const actions = steps.map((config, index) => node(`${id}:${index}`, "action", config, `Step ${index}`));
  const first = actions[0]?.id;
  const snapshot: JourneySnapshot = {
    nodes: [...triggers, ...actions],
    connections: [
      ...(first ? triggers.map((trigger) => link(trigger.id, first)) : []),
      ...actions.slice(1).map((entry, index) => link(actions[index].id, entry.id)),
    ],
  };
  store.saveJourney(TENANT, id, snapshot);
  return id;
}

/** appointment.booked → Wait 1 day → Condition on the appointment's status → yes: Reminder / no: Skipped. */
function reminderJourney(): string {
  const id = randomUUID();
  const rule: ConditionRule = { field: "appointment.status", operator: "equals", value: "scheduled" };
  store.saveJourney(TENANT, id, {
    nodes: [
      node(`${id}:t`, "trigger", { event: "appointment.booked", filters: [] }),
      node(`${id}:w`, "action", WAIT),
      node(`${id}:c`, "condition", rule as unknown as Record<string, unknown>),
      node(`${id}:yes`, "action", task("Reminder")),
      node(`${id}:no`, "action", task("Skipped")),
    ],
    connections: [link(`${id}:t`, `${id}:w`), link(`${id}:w`, `${id}:c`), link(`${id}:c`, `${id}:yes`, "yes"), link(`${id}:c`, `${id}:no`, "no")],
  });
  return id;
}

const WAIT = { action: "wait", duration: 1, unit: "days" };
const task = (title: string) => ({ action: "create_task", title, notes: "", dueInDays: null });

function newAppointment(status = "scheduled"): string {
  const id = randomUUID();
  store.appointments.set(id, { tenantId: TENANT, contactId: LEAD, status, start: "2026-10-08T15:00:00.000Z", end: null });
  return id;
}

function appointmentEvent(appointmentId: string, type = "appointment.booked", sourceId: string = randomUUID()): JourneyEvent {
  return { tenantId: TENANT, type: type as JourneyEvent["type"], sourceId, contactId: LEAD, entityType: "appointment", entityId: appointmentId, payload: {} };
}

function contactEvent(type: string, sourceId: string = randomUUID(), journeyId?: string): JourneyEvent {
  return { tenantId: TENANT, type: type as JourneyEvent["type"], sourceId, contactId: LEAD, entityType: "contact", entityId: LEAD, journeyId, payload: {} };
}

async function dispatch(event: JourneyEvent) {
  return (await dispatchJourneyEvent(deps, event)).map((outcome) => outcome.result);
}

const runsOf = (journeyId: string): MemoryRun[] => [...store.runs.values()].filter((run) => run.journeyId === journeyId);
const active = (journeyId: string) => runsOf(journeyId).filter((run) => ["running", "waiting", "paused"].includes(run.status));

async function afterWait() {
  clock = new Date(clock.getTime() + 2 * DAY);
  await resumeDueRuns(deps);
}

/** The store with the pre-insert check disabled, so only createRun's own rule (the index) decides. */
function withoutPreCheck(source: JourneyRuntimeStore): JourneyRuntimeStore {
  return new Proxy(source, {
    get(target, property, receiver) {
      if (property === "hasActiveRun") return async () => false;
      const value = Reflect.get(target, property, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

// ---------- Scope ----------

describe("appointment-scoped runs", () => {
  it("1. the same appointment can't have two active runs of a journey: a reschedule while its run waits is already_active", async () => {
    const id = journey(["appointment.booked", "appointment.rescheduled"], [WAIT, task("Prep")]);
    const a = newAppointment();
    assert.deepEqual(await dispatch(appointmentEvent(a)), ["started"]);
    assert.deepEqual(await dispatch(appointmentEvent(a, "appointment.rescheduled")), ["already_active"]);
    assert.equal(runsOf(id).length, 1);
  });

  it("2. different appointments of the same contact each get their own run", async () => {
    const id = journey(["appointment.booked"], [WAIT, task("Prep")]);
    const a = newAppointment();
    const b = newAppointment();
    assert.deepEqual(await dispatch(appointmentEvent(a)), ["started"]);
    assert.deepEqual(await dispatch(appointmentEvent(b)), ["started"]);
    assert.deepEqual(active(id).map((run) => run.entityId).sort(), [a, b].sort());
    assert.ok(active(id).every((run) => run.contactId === LEAD && run.entityType === "appointment"));
  });

  it("3. contact-scoped journeys are unchanged: a second contact event while the run waits is already_active", async () => {
    const id = journey(["lead.status_changed"], [WAIT, task("Check")]);
    assert.deepEqual(await dispatch(contactEvent("lead.status_changed")), ["started"]);
    assert.deepEqual(await dispatch(contactEvent("lead.status_changed")), ["already_active"]);
    assert.equal(runsOf(id).length, 1);
    assert.equal(runsOf(id)[0].entityType, "contact");
  });

  it("4. a cancelled appointment's reminder skips while another appointment's reminder for the same contact is sent", async () => {
    const id = reminderJourney();
    const a = newAppointment();
    const b = newAppointment();
    assert.deepEqual(await dispatch(appointmentEvent(a)), ["started"]);
    assert.deepEqual(await dispatch(appointmentEvent(b)), ["started"], "B's reminder isn't dropped while A's waits");
    store.appointments.get(a)!.status = "cancelled";
    await afterWait();
    const byAppointment = new Map(runsOf(id).map((run) => [run.id, run.entityId]));
    assert.deepEqual(
      tasks.map((entry) => [byAppointment.get(entry.runId), entry.title]).sort(),
      [[a, "Skipped"], [b, "Reminder"]].sort(),
    );
    assert.ok(runsOf(id).every((run) => run.status === "completed"));
  });

  it("5. mixed triggers: the event decides the scope; an appointment run and a manual run coexist, each scope still allows one", async () => {
    const id = journey(["appointment.booked", "manual"], [WAIT, task("Work")]);
    const a = newAppointment();
    assert.deepEqual(await dispatch(contactEvent("manual", randomUUID(), id)), ["started"]);
    assert.deepEqual(await dispatch(appointmentEvent(a)), ["started"]);
    assert.deepEqual(await dispatch(contactEvent("manual", randomUUID(), id)), ["already_active"], "a second manual run");
    assert.deepEqual(await dispatch(appointmentEvent(a)), ["already_active"], "a second run for the same appointment");
    assert.deepEqual(active(id).map((run) => run.entityType).sort(), ["appointment", "contact"]);
  });

  it("6. once an appointment's run has finished, a new event for that appointment starts a new run", async () => {
    const id = journey(["appointment.booked", "appointment.rescheduled"], [task("Prep")]);
    const a = newAppointment();
    assert.deepEqual(await dispatch(appointmentEvent(a)), ["started"]);
    assert.equal(runsOf(id)[0].status, "completed");
    assert.deepEqual(await dispatch(appointmentEvent(a, "appointment.rescheduled")), ["started"]);
    assert.equal(runsOf(id).length, 2);
  });

  it("7. children of appointment runs stay contact-scoped: the second appointment's child start is already_active", async () => {
    const child = journey(["journey.started"], [WAIT, task("Child")]);
    const parent = journey(["appointment.booked"], [{ action: "start_journey", journeyId: child }, task("Parent")]);
    assert.deepEqual(await dispatch(appointmentEvent(newAppointment())), ["started"]);
    assert.deepEqual(await dispatch(appointmentEvent(newAppointment())), ["started"]);
    assert.equal(runsOf(parent).length, 2);
    assert.equal(runsOf(child).length, 1);
    assert.equal(runsOf(child)[0].entityType, "contact");
    const second = runsOf(parent).find((run) => store.stepsFor(run.id).some((step) => step.output?.skipped_reason === "already_active"));
    assert.ok(second, "the second parent's start step was skipped as already_active");
    assert.ok(runsOf(parent).every((run) => run.status === "completed"));
  });
});

// ---------- Concurrency and failure ----------

describe("appointment-scoped concurrency (memory store)", () => {
  it("8. two events for the same appointment dispatched at once start exactly one run", async () => {
    const id = journey(["appointment.booked", "appointment.rescheduled"], [WAIT]);
    const a = newAppointment();
    deps.store = withoutPreCheck(store);
    const outcomes = await Promise.all([dispatch(appointmentEvent(a)), dispatch(appointmentEvent(a, "appointment.rescheduled"))]);
    assert.deepEqual(outcomes.flat().sort(), ["already_active", "started"]);
    assert.equal(runsOf(id).length, 1);
  });

  it("9. events for different appointments dispatched at once both start", async () => {
    const id = journey(["appointment.booked"], [WAIT]);
    deps.store = withoutPreCheck(store);
    const outcomes = await Promise.all([dispatch(appointmentEvent(newAppointment())), dispatch(appointmentEvent(newAppointment()))]);
    assert.deepEqual(outcomes.flat(), ["started", "started"]);
    assert.equal(active(id).length, 2);
  });

  it("10. an event racing its appointment's run completion: before completion it is already_active, after it starts", async () => {
    const id = journey(["appointment.booked", "appointment.rescheduled"], [WAIT, task("Prep")]);
    const a = newAppointment();
    await dispatch(appointmentEvent(a));
    assert.deepEqual(await dispatch(appointmentEvent(a, "appointment.rescheduled")), ["already_active"]);
    await afterWait();
    assert.equal(runsOf(id)[0].status, "completed");
    assert.deepEqual(await dispatch(appointmentEvent(a, "appointment.rescheduled")), ["started"]);
  });

  it("11. a failed appointment run can be retried unless that appointment already has another active run; other appointments don't block it", async () => {
    const id = journey(["appointment.booked", "appointment.rescheduled"], [task("Prep"), WAIT]);
    const a = newAppointment();
    const b = newAppointment();
    failNext = "Prep";
    await dispatch(appointmentEvent(a));
    const failed = runsOf(id)[0];
    assert.equal(failed.status, "failed");
    await dispatch(appointmentEvent(b));
    const lookups: RunRetryLookups = {
      async findRun(tenantId, runId) {
        const run = store.runs.get(runId);
        if (!run || run.tenantId !== tenantId) return null;
        const { journeyId, contactId, entityType, entityId, status, currentNodeId } = run;
        return { journeyId, contactId, entityType, entityId, status, currentNodeId, context: structuredClone(run.context) };
      },
      async latestStep(tenantId, runId) {
        const step = store.steps.filter((entry) => entry.runId === runId && entry.tenantId === tenantId).at(-1);
        return step ? { nodeId: step.nodeId, nodeType: step.nodeType, status: step.status, error: step.error ?? null } : null;
      },
      journeyStatus: (tenantId, journeyId) => store.journeyStatus(tenantId, journeyId),
      hasActiveRun: (tenantId, journeyId, contactId, appointmentId) => {
        checks.push(appointmentId ?? null);
        return store.hasActiveRun(tenantId, journeyId, contactId, appointmentId);
      },
    };
    const checks: Array<string | null> = [];
    await dispatch(appointmentEvent(a, "appointment.rescheduled"));
    const blocking = active(id).find((run) => run.entityId === a)!;
    // The write re-checks too; this asserts the pre-check itself blocks, so the caller sees why.
    const noRecheck = { retryFailedRun: async () => "retried" as const };
    assert.deepEqual(await retryJourneyRun(noRecheck, lookups, TENANT, failed.id, clock), { result: "blocked", reason: "active_run", journeyId: id });
    assert.deepEqual(checks, [a], "the pre-check asks for the failed run's appointment scope");
    assert.deepEqual(await retryJourneyRun(store, lookups, TENANT, failed.id, clock), { result: "blocked", reason: "active_run", journeyId: id });
    store.runs.get(blocking.id)!.status = "cancelled";
    assert.ok(active(id).some((run) => run.entityId === b), "B's run is still active");
    assert.deepEqual(await retryJourneyRun(store, lookups, TENANT, failed.id, clock), { result: "retried", journeyId: id });
    assert.equal(store.runs.get(failed.id)!.status, "waiting");
  });

  it("12. redelivery of the same appointment event never starts a second run", async () => {
    const id = journey(["appointment.booked"], [task("Prep")]);
    const a = newAppointment();
    const event = appointmentEvent(a);
    assert.deepEqual(await dispatch(event), ["started"]);
    assert.deepEqual(await dispatch(event), ["duplicate"]);
    deps.store = withoutPreCheck(store);
    assert.deepEqual(await dispatch(event), ["duplicate"]);
    assert.equal(runsOf(id).length, 1);
  });

  it("an appointment run and a contact-scoped run of the same journey and contact created at once both start (different scopes)", async () => {
    const id = journey(["appointment.booked", "manual"], [WAIT]);
    deps.store = withoutPreCheck(store);
    const outcomes = await Promise.all([dispatch(appointmentEvent(newAppointment())), dispatch(contactEvent("manual", randomUUID(), id))]);
    assert.deepEqual(outcomes.flat(), ["started", "started"]);
  });
});

describe("runScopeOf / inRunScope", () => {
  it("an appointment event with an appointment id is appointment-scoped; everything else is the contact's", () => {
    assert.deepEqual(runScopeOf({ contactId: "c", entityType: "appointment", entityId: "a" }), { kind: "appointment", appointmentId: "a" });
    for (const entityType of ["contact", "message", "task", "opportunity", null, undefined]) {
      assert.deepEqual(runScopeOf({ contactId: "c", entityType, entityId: "x" }), { kind: "contact", contactId: "c" }, String(entityType));
    }
    assert.deepEqual(runScopeOf({ contactId: "c", entityType: "appointment", entityId: null }), { kind: "contact", contactId: "c" });
    assert.equal(runScopeOf({ contactId: null, entityType: "contact", entityId: null }), null);
  });

  it("contact scope excludes the contact's appointment runs; appointment scope is only that appointment", () => {
    const appointmentRun = { contactId: "c", entityType: "appointment", entityId: "a" };
    const contactRun = { contactId: "c", entityType: "contact", entityId: "c" };
    assert.equal(inRunScope(appointmentRun, { kind: "contact", contactId: "c" }), false);
    assert.equal(inRunScope(contactRun, { kind: "contact", contactId: "c" }), true);
    assert.equal(inRunScope(appointmentRun, { kind: "appointment", appointmentId: "a" }), true);
    assert.equal(inRunScope(appointmentRun, { kind: "appointment", appointmentId: "b" }), false);
    assert.equal(inRunScope(contactRun, { kind: "appointment", appointmentId: "c" }), false);
  });
});

// ---------- Migration 063 preflight ----------

describe("migration 063 preflight", () => {
  const MIGRATION = readFileSync(new URL("../../../../../../supabase/migrations/063_journey_runs_appointment_scope.sql", import.meta.url), "utf8");
  let db: TestDb;

  before(async () => {
    db = await createTestDb();
  });

  after(async () => {
    await db.pg.close();
  });

  /** The schema as it was before 063 (056's contact-wide index only). */
  async function before063() {
    await db.pg.exec(`
      drop index public.journey_runs_one_active_per_appointment_idx;
      drop index public.journey_runs_one_active_per_contact_scope_idx;
      alter table public.journey_runs drop constraint journey_runs_appointment_entity_id_check;
      create unique index journey_runs_one_active_per_contact_idx on public.journey_runs (tenant_id, journey_id, contact_id)
        where contact_id is not null and status in ('running', 'waiting', 'paused');
    `);
  }

  async function activeIndexes() {
    return (await db.query<{ indexname: string }>("select indexname from pg_indexes where indexname like 'journey_runs_one_active%' order by 1")).map((row) => row.indexname);
  }

  it("stops before any change when an appointment has two active runs or an appointment run has no appointment id, and applies (repeatably) once resolved", async () => {
    await before063();
    const [{ id: tenant }] = await db.query<{ id: string }>("insert into public.tenants default values returning id");
    const appointment = randomUUID();
    const journeyId = randomUUID();
    await db.query(
      `insert into public.journey_runs (tenant_id, journey_id, contact_id, entity_type, entity_id, status, idempotency_key)
       values ($1, $2, null, 'appointment', $3, 'waiting', 'k1'), ($1, $2, null, 'appointment', $3, 'running', 'k2')`,
      [tenant, journeyId, appointment],
    );
    await assert.rejects(db.pg.exec(MIGRATION), /more than one active run for an appointment/);
    assert.deepEqual(await activeIndexes(), ["journey_runs_one_active_per_contact_idx"], "nothing changed");

    await db.query("update public.journey_runs set status = 'cancelled' where idempotency_key = 'k1'");
    await db.query("insert into public.journey_runs (tenant_id, journey_id, entity_type, entity_id, status, idempotency_key) values ($1, $2, 'appointment', null, 'completed', 'k3')", [tenant, journeyId]);
    await assert.rejects(db.pg.exec(MIGRATION), /appointment runs without entity_id/);
    assert.deepEqual(await activeIndexes(), ["journey_runs_one_active_per_contact_idx"], "nothing changed");

    await db.query("delete from public.journey_runs where idempotency_key = 'k3'");
    await db.pg.exec(MIGRATION);
    await db.pg.exec(MIGRATION);
    assert.deepEqual(await activeIndexes(), ["journey_runs_one_active_per_appointment_idx", "journey_runs_one_active_per_contact_scope_idx"]);
  });
});

// ---------- Postgres (migrations 056 + 063) and store parity ----------

const RUN_COLUMNS_SCHEMA = `
alter table public.journey_runs
  add column current_node_id text,
  add column context jsonb not null default '{}'::jsonb,
  add column error text,
  add column resume_at timestamptz,
  add column started_at timestamptz not null default now(),
  add column completed_at timestamptz,
  add column locked_until timestamptz;
`;

describe("Postgres: migration 063 indexes and the Supabase store", () => {
  let db: TestDb;
  let supabaseStore: JourneyRuntimeStore;
  let tenant: string;
  let contact: string;
  let otherContact: string;

  before(async () => {
    db = await createTestDb({ schema: RUN_COLUMNS_SCHEMA });
    attachTestDb(db);
    const { createSupabaseJourneyStore } = await import("./supabase-store.ts");
    supabaseStore = createSupabaseJourneyStore(db.client("service_role"));
  });

  after(async () => {
    await db.pg.close();
    assert.deepEqual(blockedRequests, []);
  });

  beforeEach(async () => {
    await db.reset();
    [{ id: tenant }] = await db.query<{ id: string }>("insert into public.tenants default values returning id");
    [{ id: contact }] = await db.query<{ id: string }>("insert into public.contacts (tenant_id) values ($1) returning id", [tenant]);
    [{ id: otherContact }] = await db.query<{ id: string }>("insert into public.contacts (tenant_id) values ($1) returning id", [tenant]);
  });

  function insert(run: { journeyId: string; entityType?: string; entityId?: string | null; contactId?: string | null; status?: string }) {
    return db.query(
      "insert into public.journey_runs (tenant_id, journey_id, contact_id, entity_type, entity_id, status, idempotency_key) values ($1, $2, $3, $4, $5, $6, $7)",
      [tenant, run.journeyId, run.contactId === undefined ? contact : run.contactId, run.entityType ?? "contact", run.entityId ?? null, run.status ?? "running", randomUUID()],
    );
  }

  async function violation(work: Promise<unknown>): Promise<string | null> {
    try {
      await work;
      return null;
    } catch (error) {
      return (error as { message: string }).message;
    }
  }

  it("the legacy contact-wide index is gone; the two scoped indexes and the entity check exist", async () => {
    const indexes = await db.query<{ indexname: string; indexdef: string }>(
      "select indexname, indexdef from pg_indexes where tablename = 'journey_runs' and indexname like 'journey_runs_one_active%'",
    );
    assert.deepEqual(indexes.map((row) => row.indexname).sort(), [
      "journey_runs_one_active_per_appointment_idx",
      "journey_runs_one_active_per_contact_scope_idx",
    ]);
    const appointmentIndex = indexes.find((row) => row.indexname.endsWith("appointment_idx"))!.indexdef;
    assert.match(appointmentIndex, /\(tenant_id, journey_id, entity_id\)/);
    assert.match(appointmentIndex, /'running'.*'waiting'.*'paused'/);
    assert.match(await violation(insert({ journeyId: randomUUID(), entityType: "appointment", entityId: null })) ?? "", /journey_runs_appointment_entity_id_check/);
  });

  it("same appointment: a second active run is rejected; different appointments of one contact coexist", async () => {
    const journeyId = randomUUID();
    const a = randomUUID();
    await insert({ journeyId, entityType: "appointment", entityId: a });
    assert.match(await violation(insert({ journeyId, entityType: "appointment", entityId: a })) ?? "", /journey_runs_one_active_per_appointment_idx/);
    await insert({ journeyId, entityType: "appointment", entityId: randomUUID() });
  });

  it("contact scope is unchanged for every non-appointment entity, and ignores the contact's appointment runs", async () => {
    const journeyId = randomUUID();
    await insert({ journeyId, entityType: "appointment", entityId: randomUUID() });
    await insert({ journeyId, entityType: "contact", entityId: contact });
    for (const entityType of ["contact", "message", "task", "opportunity"]) {
      assert.match(await violation(insert({ journeyId, entityType, entityId: randomUUID() })) ?? "", /journey_runs_one_active_per_contact_scope_idx/, entityType);
    }
    await insert({ journeyId, contactId: otherContact });
    await insert({ journeyId, contactId: null });
    await insert({ journeyId, contactId: null });
  });

  it("finished runs free the slot in both scopes; paused and waiting hold it", async () => {
    const journeyId = randomUUID();
    const a = randomUUID();
    for (const status of ["completed", "failed", "cancelled"]) {
      await insert({ journeyId, entityType: "appointment", entityId: a, status });
      await insert({ journeyId, status });
    }
    for (const status of ["paused", "waiting"]) {
      const scoped = randomUUID();
      await insert({ journeyId: scoped, entityType: "appointment", entityId: a, status });
      assert.ok(await violation(insert({ journeyId: scoped, entityType: "appointment", entityId: a })), status);
    }
  });

  it("8/9 (database): concurrent creates for the same appointment give one run; for different appointments, two; the conflict reads as already_active", async () => {
    const journeyId = randomUUID();
    const a = randomUUID();
    const newRun = (entityId: string, entityType = "appointment"): NewRun => ({
      tenantId: tenant,
      journeyId,
      journeyVersion: 1,
      contactId: contact,
      entityType,
      entityId,
      currentNodeId: "t",
      triggerEvent: "appointment.booked",
      triggerPayload: {},
      idempotencyKey: randomUUID(),
      resumeAt: START.toISOString(),
    });
    const same = await Promise.all([supabaseStore.createRun(newRun(a)), supabaseStore.createRun(newRun(a))]);
    assert.deepEqual(same.map((result) => (result.created ? "created" : result.alreadyActive ? "already_active" : "other")).sort(), ["already_active", "created"]);
    const different = await Promise.all([supabaseStore.createRun(newRun(randomUUID())), supabaseStore.createRun(newRun(randomUUID()))]);
    assert.ok(different.every((result) => result.created));
    const mixed = await Promise.all([supabaseStore.createRun(newRun(randomUUID())), supabaseStore.createRun(newRun(contact, "contact"))]);
    assert.ok(mixed.every((result) => result.created), "an appointment run and a contact run of one contact are different scopes");
  });

  it("13. store parity: the memory store and the Supabase store answer the same scenario the same way", async () => {
    const memory = new MemoryJourneyStore();
    memory.clock = () => START;
    const transcript = async (target: JourneyRuntimeStore, setStatus: (runId: string, status: string) => Promise<void>) => {
      const journeyId = "00000000-0000-4000-8000-000000000001";
      const otherJourney = "00000000-0000-4000-8000-000000000002";
      const a1 = "00000000-0000-4000-8000-0000000000a1";
      const a2 = "00000000-0000-4000-8000-0000000000a2";
      const log: unknown[] = [];
      const ids = new Map<string, string>();
      const create = async (name: string, spec: Partial<NewRun>) => {
        const result = await target.createRun({
          tenantId: tenant,
          journeyId,
          journeyVersion: 1,
          contactId: contact,
          entityType: "contact",
          entityId: contact,
          currentNodeId: "node-1",
          triggerEvent: "appointment.booked",
          triggerPayload: {},
          idempotencyKey: name,
          resumeAt: START.toISOString(),
          ...spec,
        });
        if (result.created && result.run) ids.set(name, result.run.id);
        log.push([name, result.created ? "created" : result.alreadyActive ? "already_active" : result.aiStepChildExists ? "ai_child" : "duplicate"]);
      };
      const has = async (label: string, contactId: string | null, appointmentId?: string | null, journey = journeyId) => {
        log.push([label, await target.hasActiveRun(tenant, journey, contactId, appointmentId)]);
      };
      const retry = async (name: string) => {
        log.push([`retry ${name}`, await target.retryFailedRun(tenant, ids.get(name)!, "node-1", { steps: {} }, START.toISOString())]);
      };
      const appt = (id: string) => ({ entityType: "appointment", entityId: id });

      await create("a1", appt(a1));
      await create("a1-again", appt(a1));
      await create("a2", appt(a2));
      await create("contact", {});
      await create("message", { entityType: "message", entityId: randomUUID() });
      await create("other-journey", { journeyId: otherJourney });
      await create("a1", appt(a1));
      await has("contact scope", contact);
      await has("a1 scope", contact, a1);
      await has("unknown appointment", contact, "00000000-0000-4000-8000-0000000000ff");
      await has("other contact", otherContact);
      await setStatus(ids.get("a1")!, "failed");
      await has("a1 after failure", contact, a1);
      await create("a1-second", appt(a1));
      await retry("a1");
      await setStatus(ids.get("a1-second")!, "cancelled");
      await retry("a1");
      await setStatus(ids.get("contact")!, "failed");
      await retry("contact");
      await setStatus(ids.get("a2")!, "paused");
      await create("a2-while-paused", appt(a2));
      await create("contactless-1", { contactId: null, entityId: null });
      await create("contactless-2", { contactId: null, entityId: null });
      await has("contact scope ignores appointment runs", otherContact);
      const appointmentOnly = "00000000-0000-4000-8000-000000000003";
      await create("appointment-only", { journeyId: appointmentOnly, ...appt(a1) });
      await has("contact scope with only an appointment run active", contact, null, appointmentOnly);
      await has("that appointment's scope", contact, a1, appointmentOnly);
      return log;
    };
    const memoryLog = await transcript(memory, async (runId, status) => {
      memory.runs.get(runId)!.status = status as MemoryRun["status"];
    });
    const databaseLog = await transcript(supabaseStore, async (runId, status) => {
      await db.query("update public.journey_runs set status = $1 where id = $2", [status, runId]);
    });
    assert.deepEqual(databaseLog, memoryLog);
    assert.deepEqual(memoryLog, [
      ["a1", "created"],
      ["a1-again", "already_active"],
      ["a2", "created"],
      ["contact", "created"],
      ["message", "already_active"],
      ["other-journey", "created"],
      ["a1", "duplicate"],
      ["contact scope", true],
      ["a1 scope", true],
      ["unknown appointment", false],
      ["other contact", false],
      ["a1 after failure", false],
      ["a1-second", "created"],
      ["retry a1", "active_run"],
      ["retry a1", "retried"],
      ["retry contact", "retried"],
      ["a2-while-paused", "already_active"],
      ["contactless-1", "created"],
      ["contactless-2", "created"],
      ["contact scope ignores appointment runs", false],
      ["appointment-only", "created"],
      ["contact scope with only an appointment run active", false],
      ["that appointment's scope", true],
    ]);
  });
});
