/**
 * Manual retry of a failed run: eligibility, the retry transition, and what the
 * worker does with the run afterwards, through the real engine on the in-memory store.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { beforeEach, describe, it } from "node:test";
import type { JourneyStatus } from "../journey-types.ts";
import type { JourneyAIExecutor } from "./ai.ts";
import {
  dispatchJourneyEvent,
  executeRun,
  INTERRUPTED_STEP_ERROR,
  JourneyStepError,
  MAX_ATTEMPTS,
  RETRY_BACKOFF_MS,
  resumeDueRuns,
  type ActionExecutor,
  type ActionInput,
  type EngineDeps,
  type JourneyEvent,
} from "./engine.ts";
import type { JourneySnapshot, SnapshotNode } from "./graph.ts";
import { MemoryJourneyStore, type MemoryRun } from "./memory-store.ts";
import {
  RETRY_BLOCK_MESSAGES,
  retryBlockReason,
  retryContext,
  retryJourneyRun,
  type RetryRun,
  type RetryStep,
  type RunRetryLookups,
} from "./run-retry.ts";

const TENANT = "tenant-a";
const OTHER_TENANT = "tenant-b";
const LEAD = "contact-1";

function node(id: string, type: SnapshotNode["type"], name: string, config: Record<string, unknown>): SnapshotNode {
  return { id, type, name, description: "", config };
}

function link(source: string, target: string) {
  return { id: `${source}->${target}`, sourceNodeId: source, targetNodeId: target, sourceHandle: null, targetHandle: null };
}

/** Trigger → Assign → Text (the step that fails) → Task */
function journey(smsBody = "Hi {{first_name}}"): JourneySnapshot {
  return {
    nodes: [
      node("t", "trigger", "New lead", { event: "lead.created", filters: [] }),
      node("a1", "action", "Assign", { action: "assign_lead", agentUserId: "11111111-1111-1111-1111-111111111111" }),
      node("s", "action", "Text lead", { action: "send_sms", body: smsBody }),
      node("n", "action", "Task", { action: "create_task", title: "Call", notes: "", dueInDays: 1 }),
    ],
    connections: [link("t", "a1"), link("a1", "s"), link("s", "n")],
  };
}

/** Records every action call; a queued error for a node makes its next call throw. */
class Actions implements ActionExecutor {
  calls: Array<{ nodeId: string; runId: string; config: Record<string, unknown> }> = [];
  failures = new Map<string, Error[]>();
  fail(nodeId: string, ...errors: Error[]) {
    this.failures.set(nodeId, [...(this.failures.get(nodeId) ?? []), ...errors]);
  }
  async execute(action: Parameters<ActionExecutor["execute"]>[0], input: ActionInput) {
    this.calls.push({ nodeId: input.nodeId, runId: input.runId, config: structuredClone(action) as Record<string, unknown> });
    const failure = this.failures.get(input.nodeId)?.shift();
    if (failure) throw failure;
    return { status: "completed" as const, output: { node: input.nodeId, ok: true } };
  }
  nodes() {
    return this.calls.map((call) => call.nodeId);
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
});

function advance(ms: number) {
  clock = new Date(clock.getTime() + ms);
}

function leadEvent(sourceId = "e1"): JourneyEvent {
  return { tenantId: TENANT, type: "lead.created", sourceId, contactId: LEAD, entityType: "contact", entityId: LEAD, payload: {} };
}

/** Lookups over the in-memory store with the same tenant scoping RLS gives the real ones. */
function lookups(source = store): RunRetryLookups {
  return {
    async findRun(tenantId, runId) {
      const run = source.runs.get(runId);
      if (!run || run.tenantId !== tenantId) return null;
      const { journeyId, contactId, status, currentNodeId } = run;
      return { journeyId, contactId, status, currentNodeId, context: structuredClone(run.context) };
    },
    async latestStep(tenantId, runId) {
      const step = source.steps.filter((entry) => entry.runId === runId && entry.tenantId === tenantId).at(-1);
      return step ? { nodeId: step.nodeId, nodeType: step.nodeType, status: step.status, error: step.error ?? null } : null;
    },
    journeyStatus: (tenantId, journeyId) => source.journeyStatus(tenantId, journeyId),
    hasActiveRun: (tenantId, journeyId, contactId) => source.hasActiveRun(tenantId, journeyId, contactId),
  };
}

const retry = (runId: string, tenantId = TENANT, using = lookups()) => retryJourneyRun(store, using, tenantId, runId, new Date(clock));

/** A run that failed at the Text step with a configuration error (the action threw before sending). */
async function failedRun(): Promise<MemoryRun> {
  store.saveJourney(TENANT, "j", journey());
  actions.fail("s", new JourneyStepError("The lead has no mobile number.", "config"));
  const [outcome] = await dispatchJourneyEvent(deps, leadEvent());
  assert.equal(outcome.execution?.status, "failed");
  return store.runs.get(outcome.runId!)!;
}

describe("retrying a failed run", () => {
  it("makes the run waiting and due now, clears its error, completion, and lease, and keeps its place", async () => {
    const run = await failedRun();
    assert.equal(run.status, "failed");
    assert.ok(run.completedAt);
    const earlierOutputs = structuredClone(run.context.steps);
    assert.ok(Object.keys(earlierOutputs).length >= 2, "trigger and Assign outputs are recorded");

    advance(10 * 60_000);
    assert.deepEqual(await retry(run.id), { result: "retried", journeyId: "j" });

    assert.equal(run.status, "waiting");
    assert.equal(run.resumeAt, clock.toISOString());
    assert.equal(run.error, null);
    assert.equal(run.completedAt, null);
    assert.equal(run.lockedUntil, null);
    assert.equal(run.currentNodeId, "s");
    assert.deepEqual(run.context.steps, earlierOutputs);
    assert.equal(run.context.attempts?.s, MAX_ATTEMPTS - 1);
  });

  it("the next worker pass runs the failed step first, never repeats earlier steps, and completes", async () => {
    const run = await failedRun();
    const failedStep = store.stepsFor(run.id).at(-1)!;
    assert.deepEqual(actions.nodes(), ["a1", "s"]);

    await retry(run.id);
    actions.calls = [];
    const result = await resumeDueRuns(deps);

    assert.deepEqual(result.outcomes.map((outcome) => outcome.status), ["completed"]);
    assert.deepEqual(actions.nodes(), ["s", "n"], "the failed step first, then later steps; Assign isn't repeated");
    assert.equal(run.status, "completed");
    assert.equal(run.error, null);

    const steps = store.stepsFor(run.id);
    assert.deepEqual(
      steps.map((step) => [step.nodeId, step.status]),
      [["t", "completed"], ["a1", "completed"], ["s", "failed"], ["s", "completed"], ["n", "completed"]],
      "trigger and Assign aren't re-recorded",
    );
    const old = steps.find((step) => step.id === failedStep.id)!;
    assert.equal(old.status, "failed");
    assert.equal(old.error, "The lead has no mobile number.", "the old failed step stays as history");
    const retried = steps[3];
    assert.notEqual(retried.id, failedStep.id, "the retry has its own step row");
    assert.equal(retried.attemptCount, MAX_ATTEMPTS);
    assert.equal(run.context.attempts?.s, undefined, "a successful step clears its attempt count");
  });
});

describe("after automatic retries are used up", () => {
  async function exhaustedRun(): Promise<MemoryRun> {
    store.saveJourney(TENANT, "j", journey());
    const outage = () => new JourneyStepError("Carrier unavailable.", "transient");
    actions.fail("s", outage(), outage(), outage());
    const [outcome] = await dispatchJourneyEvent(deps, leadEvent());
    for (const delay of RETRY_BACKOFF_MS.slice(0, MAX_ATTEMPTS - 1)) {
      advance(delay);
      await resumeDueRuns(deps);
    }
    const run = store.runs.get(outcome.runId!)!;
    assert.equal(run.status, "failed");
    assert.equal(actions.nodes().filter((id) => id === "s").length, MAX_ATTEMPTS);
    return run;
  }

  it("gives exactly one more attempt, which can succeed", async () => {
    const run = await exhaustedRun();
    await retry(run.id);
    await resumeDueRuns(deps);
    assert.equal(run.status, "completed");
    assert.equal(actions.nodes().filter((id) => id === "s").length, MAX_ATTEMPTS + 1);
  });

  it("a transient failure of that attempt fails the run again with no backoff cycle", async () => {
    const run = await exhaustedRun();
    await retry(run.id);
    actions.fail("s", new JourneyStepError("Carrier unavailable.", "transient"));
    await resumeDueRuns(deps);

    assert.equal(run.status, "failed");
    assert.equal(run.resumeAt, null, "no automatic retry scheduled");
    assert.equal(run.error, "Carrier unavailable.");
    advance(RETRY_BACKOFF_MS.at(-1)! * 2);
    await resumeDueRuns(deps);
    assert.equal(actions.nodes().filter((id) => id === "s").length, MAX_ATTEMPTS + 1, "exactly one manual attempt");
    assert.equal(actions.nodes().includes("n"), false);
  });
});

describe("unknown outcomes stay failed", () => {
  it("an interrupted step whose outcome is unknown can't be retried, and nothing runs", async () => {
    store.saveJourney(TENANT, "j", journey());
    const [outcome] = await dispatchJourneyEvent(deps, leadEvent());
    const run = store.runs.get(outcome.runId!)!;
    // The pass died while the Text step was executing.
    const stepId = await store.insertStep({ tenantId: TENANT, runId: run.id, nodeId: "s", nodeType: "action", nodeName: "Text lead", status: "running", input: {} });
    Object.assign(run, { status: "running", currentNodeId: "s", resumeAt: clock.toISOString(), lockedUntil: null, context: { steps: {}, inFlight: { nodeId: "s", stepId } } });
    assert.equal((await executeRun(deps, run.id)).status, "failed");
    assert.equal(run.error, INTERRUPTED_STEP_ERROR);
    assert.equal(run.context.inFlight, undefined);
    actions.calls = [];

    const result = await retry(run.id);
    assert.deepEqual(result, { result: "blocked", reason: "unknown_outcome", journeyId: "j" });
    assert.equal(run.status, "failed");
    await resumeDueRuns(deps);
    assert.deepEqual(actions.calls, []);
  });

  for (const [name, context, reason] of [
    ["in-flight state", { steps: {}, inFlight: { nodeId: "s", stepId: "step-x" } }, "unknown_outcome"],
    ["a waiting step", { steps: {}, waitingStepId: "step-w" }, "not_retryable_step"],
  ] as const) {
    it(`a failed run with ${name} left in its context can't be retried`, async () => {
      const run = await failedRun();
      run.context = structuredClone(context);
      actions.calls = [];
      assert.deepEqual(await retry(run.id), { result: "blocked", reason, journeyId: "j" });
      assert.equal(run.status, "failed");
      await resumeDueRuns(deps);
      assert.deepEqual(actions.calls, []);
    });
  }
});

describe("eligibility", () => {
  const failedStep: RetryStep = { nodeId: "s", nodeType: "action", status: "failed", error: "The lead has no mobile number." };
  const failed: RetryRun = { status: "failed", currentNodeId: "s", context: {} };

  it("a failed action or AI step at the current node of an active journey is retryable", () => {
    assert.equal(retryBlockReason(failed, failedStep, "active"), null);
    assert.equal(retryBlockReason({ ...failed, currentNodeId: "ai" }, { ...failedStep, nodeId: "ai", nodeType: "ai" }, "active"), null);
  });

  for (const status of ["completed", "cancelled", "running", "waiting", "paused"] as const) {
    it(`a ${status} run is rejected`, async () => {
      assert.equal(retryBlockReason({ ...failed, status }, failedStep, "active"), "not_failed");
      const run = await failedRun();
      run.status = status;
      const before = structuredClone(run);
      assert.deepEqual(await retry(run.id), { result: "blocked", reason: "not_failed", journeyId: "j" });
      assert.deepEqual(run, before);
    });
  }

  it("a run without a current node is rejected", () => {
    assert.equal(retryBlockReason({ ...failed, currentNodeId: null }, failedStep, "active"), "not_retryable_step");
  });

  it("a run that failed on a node missing from its version is rejected", async () => {
    store.saveJourney(TENANT, "j", {
      nodes: [journey().nodes[0], journey().nodes[1]],
      connections: [link("t", "a1"), link("a1", "ghost")],
    });
    const [outcome] = await dispatchJourneyEvent(deps, leadEvent());
    const run = store.runs.get(outcome.runId!)!;
    assert.equal(run.status, "failed");
    assert.equal(run.currentNodeId, "ghost");
    assert.deepEqual(await retry(run.id), { result: "blocked", reason: "not_retryable_step", journeyId: "j" });
    assert.equal(run.status, "failed");
  });

  it("a run whose version snapshot is missing is rejected", async () => {
    store.saveJourney(TENANT, "j", {
      nodes: [journey().nodes[0], node("w", "action", "Wait", { action: "wait", duration: 1, unit: "days" }), journey().nodes[2]],
      connections: [link("t", "w"), link("w", "s")],
    });
    const [outcome] = await dispatchJourneyEvent(deps, leadEvent());
    const run = store.runs.get(outcome.runId!)!;
    store.journeys.get("j")!.versions.delete(1);
    advance(2 * 86_400_000);
    await resumeDueRuns(deps);
    assert.equal(run.status, "failed");
    assert.match(run.error ?? "", /missing/);
    assert.deepEqual(await retry(run.id), { result: "blocked", reason: "not_retryable_step", journeyId: "j" });
    assert.deepEqual(actions.calls, []);
  });

  it("a run whose latest step isn't a failed step at its current node is rejected", async () => {
    assert.equal(retryBlockReason(failed, null, "active"), "not_retryable_step");
    assert.equal(retryBlockReason(failed, { ...failedStep, nodeId: "a1" }, "active"), "not_retryable_step");
    assert.equal(retryBlockReason(failed, { ...failedStep, status: "completed" }, "active"), "not_retryable_step");
    assert.equal(retryBlockReason(failed, { ...failedStep, status: "running" }, "active"), "not_retryable_step");

    const run = await failedRun();
    store.steps = store.steps.filter((step) => !(step.runId === run.id && step.nodeId === "s"));
    assert.deepEqual(await retry(run.id), { result: "blocked", reason: "not_retryable_step", journeyId: "j" });
    assert.equal(run.status, "failed");
  });

  it("a failed Condition step is rejected", async () => {
    assert.equal(retryBlockReason({ ...failed, currentNodeId: "c" }, { ...failedStep, nodeId: "c", nodeType: "condition" }, "active"), "not_retryable_step");
    const run = await failedRun();
    const step = store.stepsFor(run.id).at(-1)!;
    step.nodeType = "condition";
    assert.deepEqual(await retry(run.id), { result: "blocked", reason: "not_retryable_step", journeyId: "j" });
  });

  it("the interrupted error is matched exactly, not as a substring", () => {
    assert.equal(retryBlockReason(failed, { ...failedStep, error: INTERRUPTED_STEP_ERROR }, "active"), "unknown_outcome");
    assert.equal(retryBlockReason(failed, { ...failedStep, error: `Carrier said: ${INTERRUPTED_STEP_ERROR}` }, "active"), null);
  });
});

describe("journey lifecycle", () => {
  for (const [status, reason] of [
    ["paused", "journey_paused"],
    ["draft", "journey_not_active"],
  ] as const) {
    it(`a run of a ${status} journey is rejected`, async () => {
      const run = await failedRun();
      store.setStatus("j", status as JourneyStatus);
      const result = await retry(run.id);
      assert.deepEqual(result, { result: "blocked", reason, journeyId: "j" });
      assert.equal(run.status, "failed");
    });
  }

  it("the messages the member sees", () => {
    assert.equal(RETRY_BLOCK_MESSAGES.journey_paused, "Resume the journey before retrying its runs.");
    assert.equal(RETRY_BLOCK_MESSAGES.journey_not_active, "Only runs of active journeys can be retried.");
    assert.equal(RETRY_BLOCK_MESSAGES.not_found, "Run not found.");
    assert.equal(
      RETRY_BLOCK_MESSAGES.active_run,
      "This lead already has an active run of this journey. Cancel it or wait for it to finish.",
    );
  });

  it("a run of a deleted journey is not found", async () => {
    const run = await failedRun();
    store.journeys.delete("j");
    assert.deepEqual(await retry(run.id), { result: "blocked", reason: "not_found", journeyId: "j" });
    assert.equal(run.status, "failed");
  });
});

describe("one active run per journey and contact", () => {
  it("another active run blocks the retry; the failed run stays failed", async () => {
    const run = await failedRun();
    const other = await store.createRun({
      tenantId: TENANT, journeyId: "j", journeyVersion: 1, contactId: LEAD, entityType: "contact", entityId: LEAD,
      currentNodeId: "t", triggerEvent: "lead.created", triggerPayload: {}, idempotencyKey: "other", resumeAt: clock.toISOString(),
    });
    assert.ok(other.run);
    assert.deepEqual(await retry(run.id), { result: "blocked", reason: "active_run", journeyId: "j" });
    assert.equal(run.status, "failed");
  });

  it("an active run that appears after the check is caught by the write", async () => {
    const run = await failedRun();
    const stale = { ...lookups(), hasActiveRun: async () => false };
    await store.createRun({
      tenantId: TENANT, journeyId: "j", journeyVersion: 1, contactId: LEAD, entityType: "contact", entityId: LEAD,
      currentNodeId: "t", triggerEvent: "lead.created", triggerPayload: {}, idempotencyKey: "racer", resumeAt: clock.toISOString(),
    });
    assert.deepEqual(await retry(run.id, TENANT, stale), { result: "blocked", reason: "active_run", journeyId: "j" });
    assert.equal(run.status, "failed");
    assert.equal(run.error, "The lead has no mobile number.");
  });
});

describe("authorization", () => {
  it("a run in another workspace is invisible", async () => {
    const run = await failedRun();
    assert.deepEqual(await retry(run.id, OTHER_TENANT), { result: "blocked", reason: "not_found", journeyId: null });
    assert.equal(run.status, "failed");
  });

  it("the write with another workspace's tenant changes nothing", async () => {
    const run = await failedRun();
    const before = structuredClone(run);
    assert.equal(await store.retryFailedRun(OTHER_TENANT, run.id, "s", retryContext(run.context, "s"), clock.toISOString()), "not_failed");
    assert.deepEqual(run, before);
  });

  it("the server action takes only the run id; the tenant comes from the server session", () => {
    const source = readFileSync(new URL("../journey-actions.ts", import.meta.url), "utf8");
    const action = /export async function retryJourneyRunAction\(([^)]*)\)[^{]*\{([\s\S]*?)\n\}/.exec(source);
    assert.ok(action, "retryJourneyRunAction exists");
    assert.equal(action[1].trim(), "runId: string");
    assert.match(action[2], /await requireContext\(\)/);
    assert.match(action[2], /retryFailedJourneyRun\(context\.tenantId, text\(runId\)\)/);
  });
});

describe("versions", () => {
  it("a newer version doesn't block the retry; the run re-runs its pinned version's node", async () => {
    const run = await failedRun();
    assert.equal(run.journeyVersion, 1);
    const v2 = journey("Version two text");
    v2.nodes = v2.nodes.filter((entry) => entry.id !== "n");
    v2.connections = v2.connections.filter((entry) => entry.targetNodeId !== "n");
    assert.equal(store.saveJourney(TENANT, "j", v2), 2);

    assert.equal((await retry(run.id)).result, "retried");
    actions.calls = [];
    await resumeDueRuns(deps);

    assert.equal(run.status, "completed");
    assert.equal(run.journeyVersion, 1);
    assert.deepEqual(actions.nodes(), ["s", "n"], "version 1's graph, including the Task version 2 removed");
    assert.equal(actions.calls[0].config.body, "Hi {{first_name}}", "version 1's step configuration");
  });
});

describe("retrying twice", () => {
  it("two requests against the same failed run: exactly one makes it waiting", async () => {
    const run = await failedRun();
    const results = await Promise.all([retry(run.id), retry(run.id)]);
    assert.deepEqual(results.map((result) => result.result).sort(), ["blocked", "retried"]);
    const blocked = results.find((result) => result.result === "blocked");
    assert.equal(blocked?.result === "blocked" ? blocked.reason : null, "not_failed");
    assert.equal(run.status, "waiting");
  });

  it("the second write gets not_failed", async () => {
    const run = await failedRun();
    const context = retryContext(run.context, "s");
    assert.equal(await store.retryFailedRun(TENANT, run.id, "s", context, clock.toISOString()), "retried");
    assert.equal(await store.retryFailedRun(TENANT, run.id, "s", context, clock.toISOString()), "not_failed");
  });

  it("a write expecting a different node changes nothing", async () => {
    const run = await failedRun();
    assert.equal(await store.retryFailedRun(TENANT, run.id, "a1", retryContext(run.context, "a1"), clock.toISOString()), "not_failed");
    assert.equal(run.status, "failed");
  });
});

describe("retryContext", () => {
  it("keeps earlier outputs and other attempts, leaves one attempt for the node, and drops in-flight and wait state", () => {
    const context = {
      steps: { new_lead: { output: { event: "lead.created" } }, assign: { output: { ok: true } } },
      attempts: { s: 1, other: 2 },
      inFlight: { nodeId: "s", stepId: "step-1" },
      waitingStepId: "step-w",
    };
    const next = retryContext(context, "s");
    assert.deepEqual(next, {
      steps: { new_lead: { output: { event: "lead.created" } }, assign: { output: { ok: true } } },
      attempts: { s: MAX_ATTEMPTS - 1, other: 2 },
    });
    assert.equal(context.inFlight.stepId, "step-1", "the input isn't modified");
    assert.deepEqual(retryContext({ steps: {} }, "s"), { steps: {}, attempts: { s: MAX_ATTEMPTS - 1 } });
  });
});
