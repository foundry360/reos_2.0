/**
 * Archived journeys never execute: no new runs from events, manual enrollment,
 * or manual retry, and a run that reaches the engine after the archive is
 * cancelled without running a step. Real engine, in-memory store.
 */

import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";
import type { JourneyAIExecutor } from "./ai.ts";
import {
  dispatchJourneyEvent,
  JOURNEY_ARCHIVED_ERROR,
  JourneyStepError,
  resumeDueRuns,
  type ActionExecutor,
  type ActionInput,
  type EngineDeps,
  type JourneyEvent,
} from "./engine.ts";
import type { JourneySnapshot, SnapshotNode } from "./graph.ts";
import { enrollContactInJourney, type ManualEnrollmentLookups } from "./manual-enrollment.ts";
import { manualEnrollmentOptions } from "../manual-enrollment-options.ts";
import { MemoryJourneyStore } from "./memory-store.ts";
import { retryBlockReason, retryJourneyRun, type RunRetryLookups } from "./run-retry.ts";

const TENANT = "tenant-a";
const LEAD = "contact-1";
const DAY = 86_400_000;

function node(id: string, type: SnapshotNode["type"], name: string, config: Record<string, unknown>): SnapshotNode {
  return { id, type, name, description: "", config };
}

function link(source: string, target: string) {
  return { id: `${source}->${target}`, sourceNodeId: source, targetNodeId: target, sourceHandle: null, targetHandle: null };
}

/** Trigger → Text → Wait 1 day → Task */
function journey(): JourneySnapshot {
  return {
    nodes: [
      node("t", "trigger", "New lead", { event: "lead.created", filters: [] }),
      node("s", "action", "Text lead", { action: "send_sms", body: "Hi" }),
      node("w", "action", "Wait", { action: "wait", duration: 1, unit: "days" }),
      node("n", "action", "Task", { action: "create_task", title: "Call", notes: "", dueInDays: 1 }),
    ],
    connections: [link("t", "s"), link("s", "w"), link("w", "n")],
  };
}

class Actions implements ActionExecutor {
  calls: string[] = [];
  onExecute?: (input: ActionInput) => Promise<void> | void;
  failures: Error[] = [];
  async execute(_action: Parameters<ActionExecutor["execute"]>[0], input: ActionInput) {
    this.calls.push(input.nodeId);
    await this.onExecute?.(input);
    const failure = this.failures.shift();
    if (failure) throw failure;
    return { status: "completed" as const, output: { ok: true } };
  }
}

const ai: JourneyAIExecutor = { execute: async () => ({ success: true, output: {}, text: "" }) };

let store: MemoryJourneyStore;
let actions: Actions;
let clock: Date;
let deps: EngineDeps;

beforeEach(() => {
  store = new MemoryJourneyStore();
  actions = new Actions();
  clock = new Date("2026-10-01T12:00:00Z");
  deps = { store, actions, ai, now: () => new Date(clock) };
  store.clock = () => new Date(clock);
  store.contacts.set(LEAD, { tenantId: TENANT, lead: { first_name: "Ana" } });
  store.saveJourney(TENANT, "j", journey());
});

function leadEvent(sourceId = "e1"): JourneyEvent {
  return { tenantId: TENANT, type: "lead.created", sourceId, contactId: LEAD, entityType: "contact", entityId: LEAD, payload: {} };
}

/** What archiving does to the store: the journey is archived and its active runs cancelled. */
function archive(journeyId = "j") {
  store.setStatus(journeyId, "archived");
  for (const run of store.runs.values()) {
    if (run.journeyId !== journeyId || !["running", "waiting", "paused"].includes(run.status)) continue;
    Object.assign(run, { status: "cancelled", completedAt: clock.toISOString(), resumeAt: null, lockedUntil: null, error: JOURNEY_ARCHIVED_ERROR });
  }
}

describe("an archived journey starts no runs", () => {
  it("is excluded from event dispatch", async () => {
    archive();
    assert.deepEqual(await store.findCandidateJourneys(TENANT, "lead.created"), []);
    assert.deepEqual(await dispatchJourneyEvent(deps, leadEvent()), []);
    assert.equal(store.runs.size, 0);
    assert.deepEqual(actions.calls, []);
  });

  it("can't be manually enrolled and isn't offered in the lead page picker", async () => {
    let emitted = 0;
    const lookups: ManualEnrollmentLookups = {
      contactExists: async () => true,
      findJourney: async () => ({ status: "archived", version: 1 }),
      versionTriggerEvents: async () => ["manual"],
      hasActiveRun: async () => false,
    };
    const result = await enrollContactInJourney(
      lookups,
      () => void emitted++,
      { tenantId: TENANT, userId: "user-1", journeyId: "j", contactId: LEAD },
      () => "source-1",
    );
    assert.deepEqual(result, { result: "invalid_journey", reason: "not_active" });
    assert.equal(emitted, 0);

    const options = manualEnrollmentOptions(
      [{ id: "j", name: "Archived", description: "", status: "archived", version: 1 }],
      [{ journeyId: "j", version: 1, triggerEvents: ["manual"] }],
      [],
    );
    assert.deepEqual(options, []);
  });

  it("can't be manually retried", async () => {
    actions.failures.push(new JourneyStepError("The lead has no mobile number.", "config"));
    const [outcome] = await dispatchJourneyEvent(deps, leadEvent());
    const run = store.runs.get(outcome.runId!)!;
    assert.equal(run.status, "failed");
    archive();

    const step = { nodeId: "s", nodeType: "action", status: "failed" as const, error: "The lead has no mobile number." };
    assert.equal(retryBlockReason(run, step, "archived"), "journey_not_active");

    const lookups: RunRetryLookups = {
      findRun: async () => ({ journeyId: "j", contactId: LEAD, status: run.status, currentNodeId: run.currentNodeId, context: run.context }),
      latestStep: async () => step,
      journeyStatus: (tenantId, journeyId) => store.journeyStatus(tenantId, journeyId),
      hasActiveRun: async () => false,
    };
    assert.deepEqual(await retryJourneyRun(store, lookups, TENANT, run.id, clock), {
      result: "blocked",
      reason: "journey_not_active",
      journeyId: "j",
    });
    assert.equal(run.status, "failed");
  });
});

describe("runs that reach the engine after the archive", () => {
  it("a waiting run that becomes due is cancelled without executing an action", async () => {
    const [outcome] = await dispatchJourneyEvent(deps, leadEvent());
    const run = store.runs.get(outcome.runId!)!;
    assert.equal(run.status, "waiting");
    // The run survived the archive's cancellation (for example, it was leased at that moment).
    store.setStatus("j", "archived");
    actions.calls = [];

    clock = new Date(clock.getTime() + 2 * DAY);
    const result = await resumeDueRuns(deps);
    assert.deepEqual(result.outcomes.map((entry) => entry.status), ["cancelled"]);
    assert.equal(run.status, "cancelled");
    assert.equal(run.error, JOURNEY_ARCHIVED_ERROR);
    assert.equal(run.resumeAt, null);
    assert.equal(run.lockedUntil, null);
    assert.ok(run.completedAt);
    assert.deepEqual(actions.calls, []);
  });

  it("a run created by a dispatch that raced the archive is cancelled before its first step", async () => {
    const racing = new Proxy(store, {
      get(target, property) {
        // The dispatch saw the journey active; the archive (and its cancellation) finished before the insert.
        if (property === "createRun") {
          return async (...args: Parameters<MemoryJourneyStore["createRun"]>) => {
            archive();
            return target.createRun(...args);
          };
        }
        const value = Reflect.get(target, property, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const [outcome] = await dispatchJourneyEvent({ ...deps, store: racing }, leadEvent());

    assert.equal(outcome.result, "started");
    assert.equal(outcome.execution?.status, "cancelled");
    const run = store.runs.get(outcome.runId!)!;
    assert.equal(run.status, "cancelled");
    assert.equal(run.error, JOURNEY_ARCHIVED_ERROR);
    assert.deepEqual(actions.calls, []);
    assert.deepEqual(store.stepsFor(run.id), [], "not even the trigger step ran");
  });

  it("an execution in progress stops at the next step boundary through the lease", async () => {
    store.saveJourney(TENANT, "j", {
      nodes: [journey().nodes[0], journey().nodes[1], journey().nodes[3]],
      connections: [link("t", "s"), link("s", "n")],
    });
    actions.onExecute = (input) => {
      if (input.nodeId === "s") archive();
    };
    const [outcome] = await dispatchJourneyEvent(deps, leadEvent());

    assert.equal(outcome.execution?.status, "lease_lost");
    assert.deepEqual(actions.calls, ["s"], "the Task after the archive never runs");
    const run = store.runs.get(outcome.runId!)!;
    assert.equal(run.status, "cancelled");
    assert.equal(run.error, JOURNEY_ARCHIVED_ERROR);
  });
});

describe("history after the archive", () => {
  it("runs, steps, and the pinned version stay available", async () => {
    const [outcome] = await dispatchJourneyEvent(deps, leadEvent());
    const run = store.runs.get(outcome.runId!)!;
    const stepsBefore = structuredClone(store.stepsFor(run.id));
    archive();

    assert.equal(store.runs.get(run.id)?.status, "cancelled");
    assert.deepEqual(store.stepsFor(run.id).map((step) => step.id), stepsBefore.map((step) => step.id));
    const snapshot = await store.loadSnapshot("j", run.journeyVersion);
    assert.ok(snapshot);
    assert.deepEqual(snapshot.nodes.map((entry) => entry.id), ["t", "s", "w", "n"]);
  });
});
