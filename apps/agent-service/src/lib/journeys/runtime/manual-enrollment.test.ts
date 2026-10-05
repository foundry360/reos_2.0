import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";
import type { JourneyAIExecutor } from "./ai.ts";
import {
  dispatchJourneyEvent,
  idempotencyKey,
  JourneyStepError,
  type ActionExecutor,
  type EngineDeps,
  type JourneyEvent,
} from "./engine.ts";
import type { JourneySnapshot, SnapshotNode } from "./graph.ts";
import { enrollContactInJourney, type ManualEnrollmentLookups } from "./manual-enrollment.ts";
import { MemoryJourneyStore } from "./memory-store.ts";

const TENANT = "tenant-a";
const OTHER_TENANT = "tenant-b";
const LEAD = "contact-1";
const USER = "user-1";

function node(id: string, type: SnapshotNode["type"], name: string, config: Record<string, unknown>): SnapshotNode {
  return { id, type, name, description: "", config };
}

function link(source: string, target: string) {
  return { id: `${source}->${target}`, sourceNodeId: source, targetNodeId: target, sourceHandle: null, targetHandle: null };
}

/** Manual → Task → Wait 1 day */
function manualJourney(): JourneySnapshot {
  return {
    nodes: [
      node("t", "trigger", "Enrolled by hand", { event: "manual", filters: [] }),
      node("k", "action", "Call task", { action: "create_task", title: "Call", notes: "", dueInDays: 1 }),
      node("w", "action", "Wait", { action: "wait", duration: 1, unit: "days" }),
    ],
    connections: [link("t", "k"), link("k", "w")],
  };
}

/** Manual → Task (completes in one pass) */
function shortManualJourney(): JourneySnapshot {
  return {
    nodes: [
      node("t", "trigger", "Enrolled by hand", { event: "manual", filters: [] }),
      node("k", "action", "Call task", { action: "create_task", title: "Call", notes: "", dueInDays: 1 }),
    ],
    connections: [link("t", "k")],
  };
}

/** New lead → Task */
function leadJourney(): JourneySnapshot {
  return {
    nodes: [
      node("t", "trigger", "New lead", { event: "lead.created", filters: [] }),
      node("k", "action", "Call task", { action: "create_task", title: "Call", notes: "", dueInDays: 1 }),
    ],
    connections: [link("t", "k")],
  };
}

class RecordingActions implements ActionExecutor {
  calls: Array<{ action: string; contactId: string | null; runId: string }> = [];
  failures: Error[] = [];
  async execute(action: Parameters<ActionExecutor["execute"]>[0], input: Parameters<ActionExecutor["execute"]>[1]) {
    this.calls.push({ action: action.action, contactId: input.contactId, runId: input.runId });
    const failure = this.failures.shift();
    if (failure) throw failure;
    return { status: "completed" as const, output: { ok: true } };
  }
}

const noAI: JourneyAIExecutor = {
  async execute() {
    return { success: true, output: {}, text: "" };
  },
};

let store: MemoryJourneyStore;
let actions: RecordingActions;
let deps: EngineDeps;
let emitted: JourneyEvent[];
let lookups: ManualEnrollmentLookups;
let sourceSeq: number;

/** Same checks the live lookups make, against the in-memory store. */
function memoryLookups(memory: MemoryJourneyStore): ManualEnrollmentLookups {
  return {
    async contactExists(tenantId, contactId) {
      return memory.contacts.get(contactId)?.tenantId === tenantId;
    },
    async findJourney(tenantId, journeyId) {
      const journey = memory.journeys.get(journeyId);
      return journey && journey.tenantId === tenantId ? { status: journey.status, version: journey.version } : null;
    },
    async versionTriggerEvents(tenantId, journeyId, version) {
      const journey = memory.journeys.get(journeyId);
      const snapshot = journey && journey.tenantId === tenantId ? journey.versions.get(version) : undefined;
      if (!snapshot) return null;
      return snapshot.nodes.filter((n) => n.type === "trigger").map((n) => String(n.config.event ?? ""));
    },
    hasActiveRun: (tenantId, journeyId, contactId) => memory.hasActiveRun(tenantId, journeyId, contactId),
  };
}

beforeEach(() => {
  store = new MemoryJourneyStore();
  actions = new RecordingActions();
  deps = { store, actions, ai: noAI, now: () => new Date("2026-10-01T12:00:00Z") };
  emitted = [];
  lookups = memoryLookups(store);
  sourceSeq = 0;
  store.contacts.set(LEAD, { tenantId: TENANT, lead: { first_name: "Ana" } });
});

/** The server action's flow, with the event delivered to the real dispatcher. */
function enroll(journeyId: string, contactId = LEAD, tenantId = TENANT) {
  return enrollContactInJourney(
    lookups,
    async (event) => {
      emitted.push(event);
      await dispatchJourneyEvent(deps, event);
    },
    { tenantId, userId: USER, journeyId, contactId },
    () => `source-${++sourceSeq}`,
  );
}

const runsFor = (journeyId: string) => [...store.runs.values()].filter((run) => run.journeyId === journeyId);

describe("manual enrollment", () => {
  it("emits a journey-targeted manual event with a fresh source id", async () => {
    store.saveJourney(TENANT, "j-a", manualJourney());
    assert.deepEqual(await enroll("j-a"), { result: "enrolled" });
    assert.deepEqual(emitted, [
      {
        tenantId: TENANT,
        type: "manual",
        journeyId: "j-a",
        sourceId: "source-1",
        contactId: LEAD,
        entityType: "contact",
        entityId: LEAD,
        payload: { enrolled_by: USER },
      },
    ]);
    assert.notEqual(emitted[0].sourceId, LEAD);
  });

  it("enrolls only the selected journey when several have a manual trigger", async () => {
    store.saveJourney(TENANT, "j-a", manualJourney());
    store.saveJourney(TENANT, "j-b", manualJourney());
    await enroll("j-a");
    assert.equal(runsFor("j-a").length, 1);
    assert.equal(runsFor("j-b").length, 0, "the other manual journey gets no run");
  });

  it("pins the run to the journey's current version", async () => {
    store.saveJourney(TENANT, "j-a", manualJourney());
    store.saveJourney(TENANT, "j-a", manualJourney());
    await enroll("j-a");
    assert.equal(runsFor("j-a")[0].journeyVersion, 2);
    store.saveJourney(TENANT, "j-a", shortManualJourney());
    assert.equal(runsFor("j-a")[0].journeyVersion, 2, "later edits don't move the run");
  });

  it("runs the first step through the existing execution path, then waits", async () => {
    store.saveJourney(TENANT, "j-a", manualJourney());
    await enroll("j-a");
    const [run] = runsFor("j-a");
    assert.deepEqual(actions.calls, [{ action: "create_task", contactId: LEAD, runId: run.id }]);
    assert.equal(run.status, "waiting");
    assert.equal(run.currentNodeId, "w");
    assert.equal(run.lockedUntil, null);
    assert.equal(run.triggerEvent, "manual");
    assert.deepEqual(run.triggerPayload, { enrolled_by: USER });
    assert.deepEqual(
      store.steps.filter((step) => step.runId === run.id).map((step) => `${step.nodeId}:${step.status}`),
      ["t:completed", "k:completed", "w:running"],
    );
  });

  it("reports already_active and creates nothing while a run is waiting or paused", async () => {
    store.saveJourney(TENANT, "j-a", manualJourney());
    await enroll("j-a");
    assert.deepEqual(await enroll("j-a"), { result: "already_active" });
    runsFor("j-a")[0].status = "paused";
    assert.deepEqual(await enroll("j-a"), { result: "already_active" });
    assert.equal(runsFor("j-a").length, 1);
    assert.equal(emitted.length, 1, "no event is emitted for an already-active lead");
    assert.equal(actions.calls.length, 1);
  });

  it("the dispatcher still refuses a second active run for a targeted event", async () => {
    store.saveJourney(TENANT, "j-a", manualJourney());
    await enroll("j-a");
    const [outcome] = await dispatchJourneyEvent(deps, { ...emitted[0], sourceId: "another-request" });
    assert.equal(outcome.result, "already_active");
    assert.equal(runsFor("j-a").length, 1);
  });

  it("re-enrolls after a completed or failed run", async () => {
    store.saveJourney(TENANT, "j-a", shortManualJourney());
    await enroll("j-a");
    assert.equal(runsFor("j-a")[0].status, "completed");
    assert.deepEqual(await enroll("j-a"), { result: "enrolled" });

    actions.failures.push(new JourneyStepError("Bad config", "config"));
    await enroll("j-a");
    assert.equal(runsFor("j-a")[2].status, "failed");
    assert.deepEqual(await enroll("j-a"), { result: "enrolled" });

    assert.deepEqual(runsFor("j-a").map((run) => run.status), ["completed", "completed", "failed", "completed"]);
  });

  it("rejects a contact from another workspace", async () => {
    store.saveJourney(TENANT, "j-a", manualJourney());
    store.contacts.set("foreign", { tenantId: OTHER_TENANT, lead: {} });
    assert.deepEqual(await enroll("j-a", "foreign"), { result: "invalid_contact" });
    assert.deepEqual(await enroll("j-a", "missing"), { result: "invalid_contact" });
    assert.equal(store.runs.size, 0);
    assert.equal(emitted.length, 0);
  });

  it("rejects a journey from another workspace", async () => {
    store.saveJourney(OTHER_TENANT, "j-foreign", manualJourney());
    assert.deepEqual(await enroll("j-foreign"), { result: "invalid_journey", reason: "not_found" });
    assert.deepEqual(await enroll("j-missing"), { result: "invalid_journey", reason: "not_found" });
    assert.equal(store.runs.size, 0);
    assert.equal(emitted.length, 0);
  });

  it("rejects paused and draft journeys", async () => {
    store.saveJourney(TENANT, "j-paused", manualJourney(), "paused");
    store.saveJourney(TENANT, "j-draft", manualJourney(), "draft");
    assert.deepEqual(await enroll("j-paused"), { result: "invalid_journey", reason: "not_active" });
    assert.deepEqual(await enroll("j-draft"), { result: "invalid_journey", reason: "not_active" });
    assert.equal(store.runs.size, 0);
    assert.equal(emitted.length, 0);
  });

  it("rejects an active journey without a manual trigger", async () => {
    store.saveJourney(TENANT, "j-lead", leadJourney());
    assert.deepEqual(await enroll("j-lead"), { result: "invalid_journey", reason: "no_manual_trigger" });
    assert.equal(store.runs.size, 0);
    assert.equal(emitted.length, 0);
  });

  it("checks the current version, not an older one with a manual trigger", async () => {
    store.saveJourney(TENANT, "j-a", manualJourney());
    store.saveJourney(TENANT, "j-a", leadJourney());
    assert.deepEqual(await enroll("j-a"), { result: "invalid_journey", reason: "no_manual_trigger" });
  });
});

describe("journey-targeted dispatch", () => {
  it("untargeted events still reach every eligible journey", async () => {
    store.saveJourney(TENANT, "j-lead-1", leadJourney());
    store.saveJourney(TENANT, "j-lead-2", leadJourney());
    store.saveJourney(TENANT, "j-manual", manualJourney());
    const outcomes = await dispatchJourneyEvent(deps, {
      tenantId: TENANT,
      type: "lead.created",
      sourceId: LEAD,
      contactId: LEAD,
      entityType: "contact",
      entityId: LEAD,
      payload: {},
    });
    assert.deepEqual(outcomes.map((o) => `${o.journeyId}:${o.result}`).sort(), ["j-lead-1:started", "j-lead-2:started"]);
    assert.equal(runsFor("j-manual").length, 0);
  });

  it("a targeted event never reaches a journey that doesn't listen for it", async () => {
    store.saveJourney(TENANT, "j-lead", leadJourney());
    const outcomes = await dispatchJourneyEvent(deps, {
      tenantId: TENANT,
      type: "manual",
      journeyId: "j-lead",
      sourceId: "s",
      contactId: LEAD,
      entityType: "contact",
      entityId: LEAD,
      payload: {},
    });
    assert.deepEqual(outcomes, []);
    assert.equal(store.runs.size, 0);
  });

  it("manual events use the existing idempotency key", async () => {
    store.saveJourney(TENANT, "j-a", shortManualJourney());
    await enroll("j-a");
    const [first] = runsFor("j-a");
    assert.equal(first.idempotencyKey, idempotencyKey({ type: "manual", sourceId: "source-1" }, "j-a", 1));

    const [replay] = await dispatchJourneyEvent(deps, emitted[0]);
    assert.equal(replay.result, "duplicate", "the same request can't start a second run");
    assert.equal(replay.runId, first.id);
    assert.equal(runsFor("j-a").length, 1);
  });
});
