/**
 * Appointment-relative Wait (D.2): { action: "wait", until: { field:
 * "appointment.start", offsetMinutes } } waits until the run's own appointment
 * (its entity_id) starts, shifted by whole minutes. The target is recalculated
 * every time the run is claimed, and a waiting run never sleeps longer than
 * APPOINTMENT_WAIT_RECHECK_MS, so reschedules count without any wake-up.
 * Duration Waits are unchanged.
 *
 * Engine behaviour runs on MemoryJourneyStore with a simulated worker that
 * claims due runs every minute, as the production cron does.
 */

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { beforeEach, describe, it } from "node:test";
import type { JourneyAIExecutor } from "./ai.ts";
import {
  APPOINTMENT_WAIT_MAX_OFFSET_MINUTES,
  appointmentWaitTarget,
  isAppointmentEvent,
  nodeReferenceKey,
  parseWait,
  validateNodeConfig,
  type ConditionRule,
} from "./contracts.ts";
import {
  APPOINTMENT_WAIT_RECHECK_MS,
  dispatchJourneyEvent,
  INVALID_WAIT_ERROR,
  resumeDueRuns,
  type ActionExecutor,
  type EngineDeps,
  type JourneyEvent,
} from "./engine.ts";
import { activationIssues, knownOutputFields, producesStepOutput, type JourneySnapshot, type SnapshotNode } from "./graph.ts";
import { MemoryJourneyStore, type MemoryRun, type MemoryStep } from "./memory-store.ts";

const TENANT = randomUUID();
const LEAD = randomUUID();
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
// 2026-10-06 is a Tuesday.
const MON_NOON = "2026-10-05T12:00:00.000Z";
const TUE_9AM = "2026-10-06T09:00:00.000Z";
const TUE_1PM = "2026-10-06T13:00:00.000Z";
const TUE_2PM = "2026-10-06T14:00:00.000Z";
const WED_2PM = "2026-10-07T14:00:00.000Z";
const THU_2PM = "2026-10-08T14:00:00.000Z";
const FRI_1PM = "2026-10-09T13:00:00.000Z";
const FRI_2PM = "2026-10-09T14:00:00.000Z";

let store: MemoryJourneyStore;
let deps: EngineDeps;
let clock: Date;
/** `<task title>@<clock>` per create_task, with the run that ran it. */
let tasks: Array<{ title: string; at: string; runId: string }>;
/** Every resume_at a waiting appointment-Wait run was parked with, against the clock at that moment. */
let parks: Array<{ runId: string; at: number; resumeAt: number }>;

const ai: JourneyAIExecutor = { execute: async () => ({ success: true, output: {}, text: "" }) };

beforeEach(() => {
  clock = new Date(TUE_2PM);
  store = new MemoryJourneyStore();
  store.clock = () => clock;
  store.contacts.set(LEAD, { tenantId: TENANT, lead: { id: LEAD, first_name: "Ana" } });
  tasks = [];
  parks = [];
  const actions: ActionExecutor = {
    execute: async (action, input) => {
      if (action.action === "create_task") tasks.push({ title: action.title, at: clock.toISOString(), runId: input.runId });
      return { status: "completed", output: {} };
    },
  };
  deps = { store, actions, ai, now: () => clock };
  const updateRun = store.updateRun.bind(store);
  store.updateRun = async (runId, lease, patch) => {
    const result = await updateRun(runId, lease, patch);
    if (result === "updated" && patch.status === "waiting" && patch.resumeAt) {
      parks.push({ runId, at: clock.getTime(), resumeAt: new Date(patch.resumeAt).getTime() });
    }
    return result;
  };
});

// ---------- Helpers ----------

function node(id: string, type: SnapshotNode["type"], config: Record<string, unknown>, name = id): SnapshotNode {
  return { id, type, name, description: "", config };
}

function link(source: string, target: string, sourceHandle: string | null = null) {
  return { id: `${source}->${target}`, sourceNodeId: source, targetNodeId: target, sourceHandle, targetHandle: null };
}

const until = (offsetMinutes: number) => ({ action: "wait", until: { field: "appointment.start", offsetMinutes } });
const task = (title: string) => ({ action: "create_task", title, notes: "", dueInDays: null });
const DURATION_WAIT = { action: "wait", duration: 1, unit: "days" };

/** Triggers → steps in order; node ids `<id>:0`, `<id>:1`, … */
function graph(events: string[], steps: Record<string, unknown>[], id: string = randomUUID()): JourneySnapshot {
  const triggers = events.map((event, index) => node(`${id}:t${index}`, "trigger", { event, filters: [] }));
  const actions = steps.map((config, index) => node(`${id}:${index}`, "action", config, `Step ${index}`));
  return {
    nodes: [...triggers, ...actions],
    connections: [
      ...(actions[0] ? triggers.map((trigger) => link(trigger.id, actions[0].id)) : []),
      ...actions.slice(1).map((entry, index) => link(actions[index].id, entry.id)),
    ],
  };
}

function journey(events: string[], steps: Record<string, unknown>[]): string {
  const id = randomUUID();
  store.saveJourney(TENANT, id, graph(events, steps, id));
  return id;
}

/** appointment.booked → Wait until the appointment → Condition (rule) → yes: "Yes" / no: "No". */
function branchingJourney(offsetMinutes: number, rule: (waitId: string) => ConditionRule): { id: string; waitId: string } {
  const id = randomUUID();
  const waitId = randomUUID();
  store.saveJourney(TENANT, id, {
    nodes: [
      node(`${id}:t`, "trigger", { event: "appointment.booked", filters: [] }),
      node(waitId, "action", until(offsetMinutes), "Wait for it"),
      node(`${id}:c`, "condition", rule(waitId) as unknown as Record<string, unknown>),
      node(`${id}:yes`, "action", task("Yes")),
      node(`${id}:no`, "action", task("No")),
    ],
    connections: [link(`${id}:t`, waitId), link(waitId, `${id}:c`), link(`${id}:c`, `${id}:yes`, "yes"), link(`${id}:c`, `${id}:no`, "no")],
  });
  return { id, waitId };
}

function newAppointment(start: string, fields: { status?: string; tenantId?: string; contactId?: string } = {}): string {
  const id = randomUUID();
  store.appointments.set(id, { tenantId: fields.tenantId ?? TENANT, contactId: fields.contactId ?? LEAD, status: fields.status ?? "scheduled", start, end: null });
  return id;
}

const reschedule = (appointmentId: string, start: string) => {
  store.appointments.get(appointmentId)!.start = start;
};

function appointmentEvent(appointmentId: string, type = "appointment.booked"): JourneyEvent {
  return { tenantId: TENANT, type: type as JourneyEvent["type"], sourceId: randomUUID(), contactId: LEAD, entityType: "appointment", entityId: appointmentId, payload: {} };
}

async function book(appointmentId: string): Promise<MemoryRun> {
  const [outcome] = await dispatchJourneyEvent(deps, appointmentEvent(appointmentId));
  assert.equal(outcome.result, "started");
  return store.runs.get(outcome.runId!)!;
}

/** The worker: claims due runs once a minute until `iso`. */
async function workUntil(iso: string) {
  const end = new Date(iso).getTime();
  while (clock.getTime() < end) {
    clock = new Date(Math.min(end, clock.getTime() + MINUTE));
    await resumeDueRuns(deps);
  }
}

const waitStep = (runId: string): MemoryStep => store.stepsFor(runId).find((step) => step.nodeType === "action" && ("until" in step.input || "duration" in step.input))!;
const at = (iso: string) => new Date(iso).toISOString();

// ---------- Contract and parser safety ----------

describe("appointment Wait contract", () => {
  it("valid duration Waits parse exactly as before, in strict and draft mode", () => {
    for (const [config, expected] of [
      [{ action: "wait", duration: 1, unit: "days" }, { action: "wait", duration: 1, unit: "days" }],
      [{ action: "wait", duration: 90, unit: "minutes" }, { action: "wait", duration: 90, unit: "minutes" }],
      [{ action: "wait", duration: "2", unit: "hours" }, { action: "wait", duration: 2, unit: "hours" }],
      [{ action: "wait", duration: 1.6, unit: "days" }, { action: "wait", duration: 2, unit: "days" }],
    ] as const) {
      for (const mode of ["strict", "draft"] as const) {
        assert.deepEqual(validateNodeConfig("action", config, mode), { config: expected, errors: [] }, `${JSON.stringify(config)} ${mode}`);
      }
      assert.equal(parseWait(config as Record<string, unknown>).kind, "duration");
    }
  });

  it("out-of-range and incomplete duration Waits keep their pre-D.2 draft normalization and strict errors", () => {
    assert.deepEqual(validateNodeConfig("action", { action: "wait", duration: 0, unit: "days" }, "draft").config, { action: "wait", duration: 0, unit: "days" });
    assert.deepEqual(validateNodeConfig("action", { action: "wait", duration: 0, unit: "days" }, "strict").errors, ["Wait at least 1 day."]);
    assert.deepEqual(validateNodeConfig("action", { action: "wait", duration: 500, unit: "days" }, "draft").config, { action: "wait", duration: 90, unit: "days" });
    assert.deepEqual(validateNodeConfig("action", { action: "wait", duration: 500, unit: "days" }, "strict").errors, ["Wait at most 90 days."]);
    assert.deepEqual(validateNodeConfig("action", { action: "wait", duration: 3, unit: "weeks" }, "draft").config, { action: "wait", duration: 3, unit: "days" });
    assert.deepEqual(validateNodeConfig("action", { action: "wait", duration: "", unit: "hours" }, "strict").errors, ["Wait at least 1 hour."]);
  });

  it("valid appointment Waits parse, offsets from -90 to +90 days, zero allowed", () => {
    for (const offset of [0, -1440, 60, 1, -1, APPOINTMENT_WAIT_MAX_OFFSET_MINUTES, -APPOINTMENT_WAIT_MAX_OFFSET_MINUTES]) {
      const config = until(offset);
      for (const mode of ["strict", "draft"] as const) {
        assert.deepEqual(validateNodeConfig("action", config, mode), { config, errors: [] }, `${offset} ${mode}`);
      }
      assert.deepEqual(parseWait(config), { kind: "appointment", config, errors: [] });
    }
    assert.equal(APPOINTMENT_WAIT_MAX_OFFSET_MINUTES, 129_600);
    assert.deepEqual(parseWait(until(-0)).config, until(0));
  });

  const MALFORMED: Array<[string, Record<string, unknown>]> = [
    ["another field", { action: "wait", until: { field: "appointment.end", offsetMinutes: 0 } }],
    ["a lead field", { action: "wait", until: { field: "lead.created_at", offsetMinutes: 0 } }],
    ["no field", { action: "wait", until: { offsetMinutes: 0 } }],
    ["no offset", { action: "wait", until: { field: "appointment.start" } }],
    ["a fractional offset", { action: "wait", until: { field: "appointment.start", offsetMinutes: 1.5 } }],
    ["an offset as text", { action: "wait", until: { field: "appointment.start", offsetMinutes: "60" } }],
    ["an empty offset", { action: "wait", until: { field: "appointment.start", offsetMinutes: "" } }],
    ["an offset past 90 days", { action: "wait", until: { field: "appointment.start", offsetMinutes: 129_601 } }],
    ["an offset before -90 days", { action: "wait", until: { field: "appointment.start", offsetMinutes: -129_601 } }],
    ["seconds", { action: "wait", until: { field: "appointment.start", offsetMinutes: 0, offsetSeconds: 30 } }],
    ["an appointment id", { action: "wait", until: { field: "appointment.start", offsetMinutes: 0, appointmentId: randomUUID() } }],
    ["an absolute timestamp", { action: "wait", until: "2026-10-08T14:00:00.000Z" }],
    ["until: null", { action: "wait", until: null }],
    ["until: []", { action: "wait", until: [] }],
    ["an extra top-level key", { action: "wait", until: { field: "appointment.start", offsetMinutes: 0 }, at: "2026-10-08T14:00:00.000Z" }],
  ];

  for (const [label, config] of MALFORMED) {
    it(`a malformed until is rejected, never turned into a duration Wait: ${label}`, () => {
      assert.equal(parseWait(config).kind, "invalid");
      assert.ok(validateNodeConfig("action", config, "strict").errors.length > 0);
      const draft = validateNodeConfig("action", config, "draft").config;
      assert.ok("until" in draft && !("duration" in draft), "draft keeps the until shape");
      // Saved and loaded again (builder autosave, then a snapshot read): still invalid.
      assert.equal(parseWait(validateNodeConfig("action", draft, "draft").config).kind, "invalid");
    });
  }

  it("until together with duration or unit is ambiguous: rejected, and the draft keeps both so it stays rejected", () => {
    for (const config of [
      { action: "wait", until: { field: "appointment.start", offsetMinutes: -60 }, duration: 1, unit: "days" },
      { action: "wait", until: { field: "appointment.start", offsetMinutes: -60 }, duration: 1 },
      { action: "wait", until: { field: "appointment.start", offsetMinutes: -60 }, unit: "days" },
    ]) {
      assert.equal(parseWait(config).kind, "invalid");
      assert.deepEqual(validateNodeConfig("action", config, "strict").errors, ["Wait either for a duration or until the appointment, not both."]);
      const draft = validateNodeConfig("action", config, "draft").config;
      assert.equal(parseWait(draft).kind, "invalid");
      assert.equal(parseWait(validateNodeConfig("action", draft, "draft").config).kind, "invalid");
    }
  });

  it("a Wait with neither a duration nor an until is rejected in every mode", () => {
    for (const config of [{ action: "wait" }, { action: "wait", unit: "days" }, { action: "wait", offsetMinutes: -60 }]) {
      assert.equal(parseWait(config).kind, "invalid", JSON.stringify(config));
      assert.ok(validateNodeConfig("action", config, "strict").errors.length > 0);
      assert.equal(parseWait(validateNodeConfig("action", config, "draft").config).kind, "invalid");
    }
  });

  it("the target is the appointment's start plus the offset in absolute minutes, across a DST change too", () => {
    assert.equal(appointmentWaitTarget(THU_2PM, -1440)?.toISOString(), at(WED_2PM));
    assert.equal(appointmentWaitTarget(THU_2PM, 0)?.toISOString(), at(THU_2PM));
    assert.equal(appointmentWaitTarget(THU_2PM, 90)?.toISOString(), "2026-10-08T15:30:00.000Z");
    assert.equal(appointmentWaitTarget(new Date(THU_2PM), -60)?.toISOString(), "2026-10-08T13:00:00.000Z");
    // US clocks fall back on 2026-11-01: 24 hours before is still exactly 1,440 elapsed minutes.
    assert.equal(appointmentWaitTarget("2026-11-02T15:00:00.000Z", -1440)?.toISOString(), "2026-11-01T15:00:00.000Z");
    assert.equal(appointmentWaitTarget("2026-11-02T10:00:00-05:00", -1440)?.toISOString(), "2026-11-01T15:00:00.000Z");
    for (const start of [null, undefined, "", "not a date", 42, {}]) assert.equal(appointmentWaitTarget(start, 0), null);
  });

  it("appointment events are exactly the appointment.* triggers", () => {
    for (const event of ["appointment.booked", "appointment.rescheduled", "appointment.cancelled", "appointment.completed", "appointment.no_show"]) {
      assert.ok(isAppointmentEvent(event), event);
    }
    for (const event of ["manual", "journey.started", "lead.created", "lead.status_changed", "message.received", "", null]) {
      assert.ok(!isAppointmentEvent(event), String(event));
    }
  });
});

// ---------- Activation and graph ----------

describe("appointment Wait activation", () => {
  const messages = (snapshot: JourneySnapshot) => activationIssues(snapshot).map((issue) => issue.message);
  const triggerIssue = /waiting until the appointment needs every trigger to be an appointment event/;

  it("activates when every trigger is an appointment event", () => {
    assert.deepEqual(messages(graph(["appointment.booked"], [until(-1440), task("Remind")])), []);
    assert.deepEqual(messages(graph(["appointment.booked", "appointment.rescheduled", "appointment.no_show"], [until(30), task("Follow up")])), []);
  });

  for (const events of [["lead.created"], ["lead.status_changed"], ["manual"], ["journey.started"], ["message.received"], ["appointment.booked", "manual"], ["appointment.booked", "journey.started"], ["appointment.booked", "lead.created"]]) {
    it(`is rejected for triggers ${events.join(" + ")}`, () => {
      assert.ok(messages(graph(events, [until(-60), task("Remind")])).some((message) => triggerIssue.test(message)));
    });
  }

  it("an invalid until is rejected at activation even with appointment triggers", () => {
    assert.ok(messages(graph(["appointment.booked"], [{ action: "wait", until: { field: "appointment.start", offsetMinutes: 2.5 } }])).length > 0);
    assert.ok(messages(graph(["appointment.booked"], [{ action: "wait", until: { field: "appointment.start", offsetMinutes: 60 }, duration: 1, unit: "days" }])).length > 0);
  });

  it("duration Waits still activate on any trigger", () => {
    for (const events of [["lead.created"], ["manual"], ["journey.started"], ["appointment.booked", "manual"]]) {
      assert.deepEqual(messages(graph(events, [DURATION_WAIT, task("Later")])), [], events.join(" + "));
    }
  });

  it("an appointment Wait exposes target_at, resumed_at and late to later conditions; a duration Wait exposes nothing", () => {
    const appointmentWait = node("w", "action", until(-60));
    assert.ok(producesStepOutput(appointmentWait));
    assert.deepEqual(knownOutputFields(appointmentWait), ["target_at", "resumed_at", "late", "skipped_reason"]);
    const durationWait = node("d", "action", DURATION_WAIT);
    assert.ok(!producesStepOutput(durationWait));
    assert.equal(knownOutputFields(durationWait), null);
    assert.ok(!producesStepOutput(node("x", "action", { action: "wait", until: null })), "an invalid until has no output");
  });

  it("a condition can reference the Wait's late flag; an unknown output field is an activation issue", () => {
    const build = (field: string) => {
      const waitId = randomUUID();
      return {
        nodes: [
          node("t", "trigger", { event: "appointment.booked", filters: [] }),
          node(waitId, "action", until(-60), "Wait"),
          node("c", "condition", { field: `steps.${nodeReferenceKey(waitId)}.output.${field}`, operator: "equals", value: true }),
          node("x", "action", task("X")),
        ],
        connections: [link("t", waitId), link(waitId, "c"), link("c", "x", "yes")],
      } satisfies JourneySnapshot;
    };
    assert.deepEqual(messages(build("late")), []);
    assert.ok(messages(build("internal_state")).length > 0);
  });
});

// ---------- Runtime ----------

describe("appointment Wait runtime", () => {
  it("Tuesday 2 PM booking for Thursday 2 PM, one day before: stays waiting until Wednesday 2 PM, then continues on time", async () => {
    journey(["appointment.booked"], [until(-1440), task("Remind")]);
    const run = await book(newAppointment(THU_2PM));
    assert.equal(store.runs.get(run.id)!.status, "waiting");
    assert.equal(store.runs.get(run.id)!.resumeAt, new Date(clock.getTime() + APPOINTMENT_WAIT_RECHECK_MS).toISOString(), "first recheck in 15 minutes");
    assert.deepEqual(waitStep(run.id).output, { target_at: at(WED_2PM), resume_at: store.runs.get(run.id)!.resumeAt });
    assert.equal(waitStep(run.id).status, "running");

    await workUntil("2026-10-07T13:59:00.000Z");
    assert.deepEqual(tasks, []);
    assert.equal(store.runs.get(run.id)!.status, "waiting");
    assert.equal(waitStep(run.id).status, "running");

    await workUntil(WED_2PM);
    assert.deepEqual(tasks.map((entry) => [entry.title, entry.at]), [["Remind", at(WED_2PM)]]);
    assert.equal(store.runs.get(run.id)!.status, "completed");
    const step = waitStep(run.id);
    assert.equal(step.status, "completed");
    assert.deepEqual(step.output, { target_at: at(WED_2PM), resumed_at: at(WED_2PM), late: false });
    assert.ok(
      Object.values(store.runs.get(run.id)!.context.steps).some((entry) => JSON.stringify(entry.output) === JSON.stringify(step.output)),
      "the run's context carries the Wait's output for later conditions",
    );
  });

  it("never sleeps more than 15 minutes, and never past the target", async () => {
    journey(["appointment.booked"], [until(-1440), task("Remind")]);
    await book(newAppointment(THU_2PM));
    await workUntil(WED_2PM);
    assert.ok(parks.length > 90, `parked ${parks.length} times`);
    for (const park of parks) {
      assert.ok(park.resumeAt - park.at <= APPOINTMENT_WAIT_RECHECK_MS, "within the recheck cap");
      assert.ok(park.resumeAt <= new Date(WED_2PM).getTime(), "not past the target");
      assert.ok(park.resumeAt > park.at, "in the future");
    }
  });

  it("rescheduled later (Thursday → Friday): the old target passes without firing; it fires at the new target", async () => {
    journey(["appointment.booked", "appointment.rescheduled"], [until(-1440), task("Remind")]);
    const appointment = newAppointment(THU_2PM);
    const run = await book(appointment);
    await workUntil("2026-10-06T18:00:00.000Z");
    reschedule(appointment, FRI_2PM);
    const [again] = await dispatchJourneyEvent(deps, appointmentEvent(appointment, "appointment.rescheduled"));
    assert.equal(again.result, "already_active", "the reschedule doesn't start another run");

    await workUntil("2026-10-08T13:59:00.000Z");
    assert.deepEqual(tasks, [], "not at the old Wednesday target, nor any time before the new one");
    assert.equal(waitStep(run.id).output?.target_at, at(THU_2PM), "the step shows the new target");
    await workUntil(THU_2PM);
    assert.deepEqual(tasks.map((entry) => entry.at), [at(THU_2PM)]);
    assert.deepEqual(waitStep(run.id).output, { target_at: at(THU_2PM), resumed_at: at(THU_2PM), late: false });
  });

  it("rescheduled twice (Tuesday → Thursday → Friday): fires once, an hour before Friday's start", async () => {
    clock = new Date(MON_NOON);
    journey(["appointment.booked"], [until(-60), task("Remind")]);
    const appointment = newAppointment(TUE_2PM);
    const run = await book(appointment);
    await workUntil("2026-10-05T18:00:00.000Z");
    reschedule(appointment, THU_2PM);
    await workUntil("2026-10-07T09:00:00.000Z");
    assert.deepEqual(tasks, [], "Tuesday 1 PM passed without firing");
    reschedule(appointment, FRI_2PM);
    await workUntil("2026-10-09T23:00:00.000Z");
    assert.deepEqual(tasks.map((entry) => entry.at), [at(FRI_1PM)]);
    assert.deepEqual(waitStep(run.id).output, { target_at: at(FRI_1PM), resumed_at: at(FRI_1PM), late: false });
  });

  it("rescheduled earlier (Friday → Tuesday): noticed by the 15-minute recheck without any wake-up, and fires at the new target", async () => {
    clock = new Date(MON_NOON);
    journey(["appointment.booked"], [until(-60), task("Remind")]);
    const appointment = newAppointment(FRI_2PM);
    const run = await book(appointment);
    await workUntil(TUE_9AM);
    reschedule(appointment, TUE_2PM);
    const resumeAt = store.runs.get(run.id)!.resumeAt;
    assert.ok(new Date(resumeAt!).getTime() - clock.getTime() <= APPOINTMENT_WAIT_RECHECK_MS, "the run is due again within 15 minutes; nothing woke it");
    await workUntil("2026-10-06T09:15:00.000Z");
    assert.equal(waitStep(run.id).output?.target_at, at(TUE_1PM), "the earlier target is picked up by the recheck");
    await workUntil(TUE_2PM);
    assert.deepEqual(tasks.map((entry) => entry.at), [at(TUE_1PM)]);
    assert.equal(waitStep(run.id).output?.late, false);
  });

  it("rescheduled earlier past the target: continues at the next recheck, late", async () => {
    clock = new Date(MON_NOON);
    journey(["appointment.booked"], [until(-60), task("Remind")]);
    const appointment = newAppointment(FRI_2PM);
    const run = await book(appointment);
    await workUntil("2026-10-06T13:30:00.000Z");
    reschedule(appointment, TUE_2PM);
    await workUntil("2026-10-06T13:46:00.000Z");
    assert.equal(tasks.length, 1);
    assert.ok(new Date(tasks[0].at).getTime() <= new Date("2026-10-06T13:45:00.000Z").getTime(), `fired at ${tasks[0].at}`);
    assert.deepEqual(waitStep(run.id).output, { target_at: at(TUE_1PM), resumed_at: tasks[0].at, late: true });
  });

  it("a target already in the past when the Wait starts continues at once, late", async () => {
    journey(["appointment.booked"], [until(-60), task("Remind")]);
    const run = await book(newAppointment("2026-10-06T14:30:00.000Z"));
    assert.equal(store.runs.get(run.id)!.status, "completed");
    assert.deepEqual(tasks.map((entry) => entry.at), [at(TUE_2PM)]);
    assert.deepEqual(waitStep(run.id).output, { target_at: "2026-10-06T13:30:00.000Z", resumed_at: at(TUE_2PM), late: true });
    assert.equal(waitStep(run.id).status, "completed");
    assert.deepEqual(waitStep(run.id).input, { until: { field: "appointment.start", offsetMinutes: -60 } });
  });

  it("a target exactly now continues at once and isn't late", async () => {
    journey(["appointment.booked"], [until(0), task("Remind")]);
    const run = await book(newAppointment(TUE_2PM));
    assert.equal(store.runs.get(run.id)!.status, "completed");
    assert.deepEqual(waitStep(run.id).output, { target_at: at(TUE_2PM), resumed_at: at(TUE_2PM), late: false });
  });

  it("a target one minute ahead waits for it, then isn't late", async () => {
    journey(["appointment.booked"], [until(1), task("Remind")]);
    const run = await book(newAppointment(TUE_2PM));
    assert.equal(store.runs.get(run.id)!.status, "waiting");
    assert.equal(store.runs.get(run.id)!.resumeAt, "2026-10-06T14:01:00.000Z", "the target, sooner than the recheck");
    await workUntil("2026-10-06T14:01:00.000Z");
    assert.deepEqual(waitStep(run.id).output, { target_at: "2026-10-06T14:01:00.000Z", resumed_at: "2026-10-06T14:01:00.000Z", late: false });
  });

  it("a missing appointment skips the Wait (appointment_not_found) and the journey continues", async () => {
    journey(["appointment.booked"], [until(-60), task("Next")]);
    const [outcome] = await dispatchJourneyEvent(deps, appointmentEvent(randomUUID()));
    const run = store.runs.get(outcome.runId!)!;
    assert.equal(run.status, "completed");
    assert.deepEqual(waitStep(run.id).output, { skipped_reason: "appointment_not_found" });
    assert.equal(waitStep(run.id).status, "skipped");
    assert.deepEqual(tasks.map((entry) => entry.title), ["Next"]);
  });

  it("an appointment deleted while waiting is skipped at the next recheck and the journey continues", async () => {
    journey(["appointment.booked"], [until(-1440), task("Next")]);
    const appointment = newAppointment(THU_2PM);
    const run = await book(appointment);
    await workUntil("2026-10-06T15:00:00.000Z");
    store.appointments.delete(appointment);
    await workUntil("2026-10-06T15:16:00.000Z");
    assert.equal(store.runs.get(run.id)!.status, "completed");
    assert.equal(waitStep(run.id).status, "skipped");
    assert.deepEqual(waitStep(run.id).output, { skipped_reason: "appointment_not_found" });
    assert.deepEqual(tasks.map((entry) => entry.title), ["Next"]);
  });

  it("an appointment of another workspace or another lead is never used: skipped as not found", async () => {
    journey(["appointment.booked"], [until(-60), task("Next")]);
    for (const appointment of [newAppointment(THU_2PM, { tenantId: randomUUID() }), newAppointment(THU_2PM, { contactId: randomUUID() })]) {
      const [outcome] = await dispatchJourneyEvent(deps, appointmentEvent(appointment));
      const run = store.runs.get(outcome.runId!)!;
      assert.equal(run.status, "completed");
      assert.deepEqual(waitStep(run.id).output, { skipped_reason: "appointment_not_found" });
    }
  });

  it("each run waits for its own appointment, not the lead's latest or soonest one", async () => {
    journey(["appointment.booked"], [until(-60), task("Remind")]);
    const thursday = newAppointment(THU_2PM);
    const thursdayRun = await book(thursday);
    const wednesday = newAppointment(WED_2PM);
    const wednesdayRun = await book(wednesday);
    const friday = newAppointment(FRI_2PM);
    const fridayRun = await book(friday);
    await workUntil("2026-10-09T23:00:00.000Z");
    const byRun = new Map(tasks.map((entry) => [entry.runId, entry.at]));
    assert.equal(byRun.get(wednesdayRun.id), "2026-10-07T13:00:00.000Z");
    assert.equal(byRun.get(thursdayRun.id), "2026-10-08T13:00:00.000Z");
    assert.equal(byRun.get(fridayRun.id), at(FRI_1PM));
    assert.deepEqual([thursdayRun, wednesdayRun, fridayRun].map((run) => store.runs.get(run.id)!.entityId), [thursday, wednesday, friday]);
  });

  it("an invalid until in a published snapshot fails the run; it never waits for some duration", async () => {
    const id = journey(["appointment.booked"], [{ action: "wait", until: { field: "appointment.start", offsetMinutes: "soon" } }, task("Never")]);
    const [outcome] = await dispatchJourneyEvent(deps, appointmentEvent(newAppointment(THU_2PM)));
    const run = store.runs.get(outcome.runId!)!;
    assert.equal(run.status, "failed");
    assert.equal(run.error, INVALID_WAIT_ERROR);
    assert.equal(run.resumeAt, null);
    assert.equal(waitStep(run.id).status, "failed");
    assert.deepEqual(tasks, []);
    assert.equal(store.journeys.get(id)!.status, "active");
  });

  it("an ambiguous Wait (until plus duration) fails the run instead of waiting for the duration", async () => {
    journey(["appointment.booked"], [{ action: "wait", until: { field: "appointment.start", offsetMinutes: -60 }, duration: 1, unit: "days" }, task("Never")]);
    const [outcome] = await dispatchJourneyEvent(deps, appointmentEvent(newAppointment(THU_2PM)));
    assert.equal(store.runs.get(outcome.runId!)!.status, "failed");
    assert.equal(store.runs.get(outcome.runId!)!.error, INVALID_WAIT_ERROR);
  });

  it("a waiting run whose Wait reads as invalid when claimed fails instead of closing the Wait", async () => {
    const id = journey(["appointment.booked"], [until(-1440), task("Never")]);
    const run = await book(newAppointment(THU_2PM));
    store.journeys.get(id)!.versions.get(store.runs.get(run.id)!.journeyVersion)!.nodes.find((entry) => entry.id === waitStep(run.id).nodeId)!.config = {
      action: "wait",
      until: { field: "appointment.end", offsetMinutes: 0 },
    };
    await workUntil("2026-10-06T14:16:00.000Z");
    assert.equal(store.runs.get(run.id)!.status, "failed");
    assert.equal(store.runs.get(run.id)!.error, INVALID_WAIT_ERROR);
    assert.equal(waitStep(run.id).status, "failed");
    assert.deepEqual(tasks, []);
  });
});

// ---------- Appointment lifecycle ----------

describe("appointment Wait and the appointment's state", () => {
  for (const status of ["cancelled", "completed", "no_show"]) {
    it(`an appointment that becomes ${status} doesn't end the Wait early; the status condition after it decides`, async () => {
      const { id } = branchingJourney(-1440, () => ({ field: "appointment.status", operator: "equals", value: "scheduled" }));
      const appointment = newAppointment(THU_2PM);
      const run = await book(appointment);
      await workUntil("2026-10-06T16:00:00.000Z");
      store.appointments.get(appointment)!.status = status;
      await workUntil("2026-10-07T13:59:00.000Z");
      assert.equal(store.runs.get(run.id)!.status, "waiting", "still waiting for the target");
      assert.deepEqual(tasks, []);
      await workUntil(WED_2PM);
      assert.deepEqual(tasks.map((entry) => [entry.title, entry.at]), [["No", at(WED_2PM)]]);
      assert.equal(store.runs.get(run.id)!.status, "completed");
      assert.equal(store.journeys.get(id)!.status, "active");
    });
  }

  it("a scheduled appointment takes the yes branch", async () => {
    branchingJourney(-1440, () => ({ field: "appointment.status", operator: "equals", value: "scheduled" }));
    await book(newAppointment(THU_2PM));
    await workUntil(WED_2PM);
    assert.deepEqual(tasks.map((entry) => entry.title), ["Yes"]);
  });

  it("a later condition can branch on the Wait's late flag", async () => {
    const lateRule = (waitId: string): ConditionRule => ({ field: `steps.${nodeReferenceKey(waitId)}.output.late`, operator: "equals", value: true });
    branchingJourney(-60, lateRule);
    await book(newAppointment("2026-10-06T14:30:00.000Z"));
    await book(newAppointment(THU_2PM));
    await workUntil("2026-10-08T13:00:00.000Z");
    assert.deepEqual(tasks.map((entry) => [entry.title, entry.at]), [["Yes", at(TUE_2PM)], ["No", "2026-10-08T13:00:00.000Z"]]);
  });
});

// ---------- Pause, cancel, recovery, concurrency ----------

describe("appointment Wait with pause, cancel, recovery and concurrency", () => {
  /** What resumePausedRuns does to a paused run: due now. */
  const resumePaused = (journeyId: string) => {
    store.setStatus(journeyId, "active");
    for (const run of store.runs.values()) {
      if (run.journeyId === journeyId && run.status === "paused") {
        run.status = "waiting";
        run.resumeAt = clock.toISOString();
      }
    }
  };

  it("paused past the target: on resume it recalculates and continues, late", async () => {
    const id = journey(["appointment.booked"], [until(-1440), task("Remind")]);
    const run = await book(newAppointment(THU_2PM));
    store.setStatus(id, "paused");
    await workUntil("2026-10-06T14:20:00.000Z");
    assert.equal(store.runs.get(run.id)!.status, "paused");
    clock = new Date("2026-10-07T18:00:00.000Z");
    await resumeDueRuns(deps);
    assert.deepEqual(tasks, [], "paused runs don't run");
    resumePaused(id);
    await resumeDueRuns(deps);
    assert.deepEqual(tasks.map((entry) => entry.at), ["2026-10-07T18:00:00.000Z"]);
    assert.deepEqual(waitStep(run.id).output, { target_at: at(WED_2PM), resumed_at: "2026-10-07T18:00:00.000Z", late: true });
  });

  it("paused before the target, rescheduled while paused: on resume it re-parks for the new target", async () => {
    const id = journey(["appointment.booked"], [until(-1440), task("Remind")]);
    const appointment = newAppointment(THU_2PM);
    const run = await book(appointment);
    store.setStatus(id, "paused");
    await workUntil("2026-10-06T14:20:00.000Z");
    reschedule(appointment, FRI_2PM);
    clock = new Date("2026-10-07T18:00:00.000Z");
    resumePaused(id);
    await resumeDueRuns(deps);
    assert.equal(store.runs.get(run.id)!.status, "waiting");
    assert.equal(store.runs.get(run.id)!.resumeAt, "2026-10-07T18:15:00.000Z");
    assert.equal(waitStep(run.id).output?.target_at, at(THU_2PM));
    assert.equal(waitStep(run.id).status, "running");
    await workUntil(THU_2PM);
    assert.deepEqual(tasks.map((entry) => entry.at), [at(THU_2PM)]);
  });

  it("a run cancelled while waiting is never resumed", async () => {
    journey(["appointment.booked"], [until(-1440), task("Remind")]);
    const run = await book(newAppointment(THU_2PM));
    store.runs.get(run.id)!.status = "cancelled";
    store.runs.get(run.id)!.resumeAt = null;
    await workUntil(THU_2PM);
    assert.deepEqual(tasks, []);
    assert.equal(waitStep(run.id).status, "running");
  });

  it("a pass that died holding the lease is picked up after the lease expires and recalculates", async () => {
    journey(["appointment.booked"], [until(-60), task("Remind")]);
    const appointment = newAppointment(THU_2PM);
    const run = await book(appointment);
    clock = new Date("2026-10-06T14:15:00.000Z");
    assert.ok(await store.claimRun(run.id, clock, new Date(clock.getTime() + 5 * MINUTE)), "a pass claims it, then dies");
    reschedule(appointment, "2026-10-06T14:30:00.000Z");
    await resumeDueRuns(deps);
    assert.deepEqual(tasks, [], "still leased");
    await workUntil("2026-10-06T14:19:00.000Z");
    assert.deepEqual(tasks, [], "still leased until 14:20");
    await workUntil("2026-10-06T14:20:00.000Z");
    assert.deepEqual(tasks.map((entry) => entry.at), ["2026-10-06T14:20:00.000Z"]);
    assert.deepEqual(waitStep(run.id).output, { target_at: "2026-10-06T13:30:00.000Z", resumed_at: "2026-10-06T14:20:00.000Z", late: true });
  });

  it("two workers claiming at the same moment continue it once", async () => {
    journey(["appointment.booked"], [until(-60), task("Remind")]);
    const run = await book(newAppointment("2026-10-06T15:10:00.000Z"));
    clock = new Date("2026-10-06T14:10:00.000Z");
    await Promise.all([resumeDueRuns(deps), resumeDueRuns(deps), resumeDueRuns(deps)]);
    assert.deepEqual(tasks.map((entry) => entry.runId), [run.id]);
    assert.equal(store.stepsFor(run.id).filter((step) => step.status === "completed" && "target_at" in (step.output ?? {})).length, 1);
  });
});

// ---------- Duration Waits are unchanged ----------

describe("duration Waits after D.2", () => {
  it("record and resume exactly as before", async () => {
    journey(["lead.created"], [DURATION_WAIT, task("Later")]);
    const [outcome] = await dispatchJourneyEvent(deps, { tenantId: TENANT, type: "lead.created", sourceId: randomUUID(), contactId: LEAD, entityType: "contact", entityId: LEAD, payload: {} });
    const run = store.runs.get(outcome.runId!)!;
    assert.equal(run.status, "waiting");
    assert.equal(run.resumeAt, new Date(clock.getTime() + DAY).toISOString(), "no 15-minute recheck for durations");
    assert.deepEqual(waitStep(run.id).input, { duration: 1, unit: "days" });
    assert.deepEqual(waitStep(run.id).output, { resume_at: run.resumeAt });
    clock = new Date(clock.getTime() + DAY);
    await resumeDueRuns(deps);
    assert.deepEqual(waitStep(run.id).output, { resumed_at: clock.toISOString() });
    assert.equal(store.runs.get(run.id)!.status, "completed");
    assert.deepEqual(tasks.map((entry) => entry.title), ["Later"]);
  });

  it("duration Waits in appointment journeys don't recheck and don't read the appointment", async () => {
    journey(["appointment.booked"], [{ action: "wait", duration: 2, unit: "hours" }, task("Later")]);
    const appointment = newAppointment(THU_2PM);
    const run = await book(appointment);
    assert.equal(store.runs.get(run.id)!.resumeAt, "2026-10-06T16:00:00.000Z");
    store.appointments.delete(appointment);
    await workUntil("2026-10-06T16:00:00.000Z");
    assert.deepEqual(tasks.map((entry) => entry.at), ["2026-10-06T16:00:00.000Z"]);
    assert.deepEqual(waitStep(run.id).output, { resumed_at: "2026-10-06T16:00:00.000Z" });
    assert.deepEqual(parks.map((park) => park.resumeAt - park.at), [2 * HOUR], "parked once, for the whole duration");
  });

  it("a legacy config with a text duration still waits that long", async () => {
    journey(["lead.created"], [{ action: "wait", duration: "3", unit: "hours" }, task("Later")]);
    const [outcome] = await dispatchJourneyEvent(deps, { tenantId: TENANT, type: "lead.created", sourceId: randomUUID(), contactId: LEAD, entityType: "contact", entityId: LEAD, payload: {} });
    assert.equal(store.runs.get(outcome.runId!)!.resumeAt, "2026-10-06T17:00:00.000Z");
  });

  it("a duration run parked before D.2 (waitingStepId set, no target) closes as before when due", async () => {
    const id = journey(["lead.created"], [DURATION_WAIT, task("Later")]);
    const snapshot = store.journeys.get(id)!.versions.get(1)!;
    const waitNode = snapshot.nodes.find((entry) => entry.config.action === "wait")!;
    const run = (await store.createRun({
      tenantId: TENANT,
      journeyId: id,
      journeyVersion: 1,
      contactId: LEAD,
      entityType: "contact",
      entityId: LEAD,
      triggerEvent: "lead.created",
      triggerPayload: {},
      idempotencyKey: randomUUID(),
      startedAt: clock.toISOString(),
    } as Parameters<MemoryJourneyStore["createRun"]>[0])).run;
    const stepId = await store.insertStep({ tenantId: TENANT, runId: run.id, nodeId: waitNode.id, nodeType: "action", nodeName: waitNode.name, status: "running", input: { duration: 1, unit: "days" }, output: { resume_at: clock.toISOString() } });
    Object.assign(store.runs.get(run.id)!, { status: "waiting", currentNodeId: waitNode.id, context: { steps: {}, waitingStepId: stepId }, resumeAt: clock.toISOString() });
    await resumeDueRuns(deps);
    assert.equal(store.runs.get(run.id)!.status, "completed");
    assert.deepEqual(store.steps.find((step) => step.id === stepId)!.output, { resumed_at: clock.toISOString() });
  });

  it("a paused and resumed duration run continues as before", async () => {
    const id = journey(["lead.created"], [DURATION_WAIT, task("Later")]);
    const [outcome] = await dispatchJourneyEvent(deps, { tenantId: TENANT, type: "lead.created", sourceId: randomUUID(), contactId: LEAD, entityType: "contact", entityId: LEAD, payload: {} });
    store.setStatus(id, "paused");
    clock = new Date(clock.getTime() + 2 * DAY);
    await resumeDueRuns(deps);
    assert.equal(store.runs.get(outcome.runId!)!.status, "paused");
    store.setStatus(id, "active");
    Object.assign(store.runs.get(outcome.runId!)!, { status: "waiting", resumeAt: clock.toISOString() });
    await resumeDueRuns(deps);
    assert.equal(store.runs.get(outcome.runId!)!.status, "completed");
    assert.deepEqual(tasks.map((entry) => entry.title), ["Later"]);
  });

  it("a cloned journey (same graph under a new id) with either Wait behaves the same", async () => {
    const original = graph(["appointment.booked"], [until(-60), DURATION_WAIT, task("Done")], "orig");
    const cloneId = randomUUID();
    const clone: JourneySnapshot = structuredClone(original);
    for (const entry of clone.nodes) entry.id = entry.id.replace("orig", cloneId);
    for (const connection of clone.connections) {
      connection.sourceNodeId = connection.sourceNodeId.replace("orig", cloneId);
      connection.targetNodeId = connection.targetNodeId.replace("orig", cloneId);
    }
    assert.deepEqual(activationIssues(clone), []);
    store.saveJourney(TENANT, cloneId, clone);
    const run = await book(newAppointment("2026-10-06T14:30:00.000Z"));
    assert.equal(store.runs.get(run.id)!.status, "waiting");
    assert.equal(store.runs.get(run.id)!.resumeAt, new Date(clock.getTime() + DAY).toISOString(), "past the late appointment Wait, now on the duration Wait");
  });
});
