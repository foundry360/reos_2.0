/**
 * Call-and-wait: a start_journey step with waitForCompletion parks its run
 * (waiting, unleased) on the one child its run key identifies, and continues
 * with child_status once that child is completed, failed, or cancelled. Real
 * engine, dispatcher, worker entry (resumeDueRuns), run retry, and memory store.
 */

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { beforeEach, describe, it } from "node:test";
import type { JourneyAIExecutor } from "./ai.ts";
import { nodeReferenceKey, validateNodeConfig, type InputMapping } from "./contracts.ts";
import {
  CHILD_WAIT_RECHECK_MS,
  dispatchJourneyEvent,
  executeRun,
  JourneyStepError,
  LEASE_MS,
  RETRY_BACKOFF_MS,
  resumeDueRuns,
  runCausationDepth,
  type ActionExecutor,
  type EngineDeps,
} from "./engine.ts";
import type { SnapshotNode } from "./graph.ts";
import { MemoryJourneyStore, type MemoryRun } from "./memory-store.ts";
import { retryJourneyRun, type RunRetryLookups } from "./run-retry.ts";

let store: MemoryJourneyStore;
let deps: EngineDeps;
let tenant: string;
let contact: string;
let clock: number;
let names: Map<string, string>;
/** "<journey>:<task title or action>" for every non-engine action, in order. */
let performed: string[];
/** Journey names whose next Create task fails permanently / transiently (once each). */
let failNextTask: Set<string>;
let failNextTaskTransient: Set<string>;
let aiOutputs: Map<string, Record<string, unknown>>;

const DAY = 24 * 60 * 60_000;
const advance = (ms: number) => {
  clock += ms;
};

beforeEach(() => {
  store = new MemoryJourneyStore();
  clock = Date.now();
  store.clock = () => new Date(clock);
  tenant = randomUUID();
  contact = randomUUID();
  names = new Map();
  performed = [];
  failNextTask = new Set();
  failNextTaskTransient = new Set();
  aiOutputs = new Map();
  store.contacts.set(contact, { tenantId: tenant, lead: { lead_status: "New", record_type: "lead", budget: "500k" } });

  const ai: JourneyAIExecutor = {
    async execute(request) {
      return { success: true, output: aiOutputs.get(request.nodeId) ?? {}, text: "child reasoning" };
    },
  };
  const actions: ActionExecutor = {
    async execute(action, input) {
      const journeyName = names.get(input.nodeId.slice(0, 36)) ?? "?";
      if (action.action === "create_task" && failNextTask.delete(journeyName)) throw new JourneyStepError("Task rejected.", "config");
      if (action.action === "create_task" && failNextTaskTransient.delete(journeyName)) throw new JourneyStepError("Task service busy.", "transient");
      performed.push(`${journeyName}:${action.action === "create_task" ? action.title : action.action}`);
      return { status: "completed", output: {} };
    },
  };
  deps = { store, actions, ai, now: () => new Date(clock) };
});

type Step = Record<string, unknown> & { type?: "action" | "ai" };
const task = (title = "Follow up"): Step => ({ action: "create_task", title, notes: "", dueInDays: 1 });
const callWait = (journeyId: string, inputMappings?: InputMapping[]): Step => ({
  action: "start_journey",
  journeyId,
  waitForCompletion: true,
  ...(inputMappings ? { inputMappings } : {}),
});
const start = (journeyId: string): Step => ({ action: "start_journey", journeyId });
const aiStep = (): Step => ({ type: "ai", goal: "Score", instructions: "", agent: "default" });
const waitDay: Step = { action: "wait", duration: 1, unit: "days" };

/** Trigger → steps in order. Node ids are `<journey id>-n<index>`; the trigger is `<journey id>-t`. */
function journey(name: string, event: string, steps: Step[], { id = randomUUID(), tenantId = tenant } = {}) {
  names.set(id, name);
  const nodes: SnapshotNode[] = [
    { id: `${id}-t`, type: "trigger", name: "Trigger", description: "", config: { event, filters: [] } },
    ...steps.map(({ type = "action", ...config }, index): SnapshotNode => ({ id: `${id}-n${index}`, type, name: `Step ${index}`, description: "", config })),
  ];
  store.saveJourney(tenantId, id, {
    nodes,
    connections: nodes.slice(1).map((node, index) => ({ id: `${id}-c${index}`, sourceNodeId: nodes[index].id, targetNodeId: node.id, sourceHandle: null, targetHandle: null })),
  });
  return id;
}

/** Manual trigger → call-and-wait `target` → Condition child_status equals completed → task "ok" / task "child <status>". */
function waitThenBranch(name: string, target: string) {
  const id = randomUUID();
  names.set(id, name);
  const node = (suffix: string, type: SnapshotNode["type"], config: Record<string, unknown>): SnapshotNode => ({ id: `${id}-${suffix}`, type, name: suffix, description: "", config });
  const link = (source: string, targetNode: string, sourceHandle: string | null = null) => ({ id: `${source}>${targetNode}`, sourceNodeId: `${id}-${source}`, targetNodeId: `${id}-${targetNode}`, sourceHandle, targetHandle: null });
  store.saveJourney(tenant, id, {
    nodes: [
      node("t", "trigger", { event: "manual", filters: [] }),
      node("n0", "action", callWait(target)),
      node("c", "condition", { field: `steps.${nodeReferenceKey(`${id}-n0`)}.output.child_status`, operator: "equals", value: "completed" }),
      node("y", "action", task("ok")),
      node("n", "action", task("child not completed")),
    ],
    connections: [link("t", "n0"), link("n0", "c"), link("c", "y", "yes"), link("c", "n", "no")],
  });
  return id;
}

async function enroll(journeyId: string, contactId: string | null = contact) {
  return dispatchJourneyEvent(deps, {
    tenantId: tenant, type: "manual", journeyId, sourceId: randomUUID(), contactId, entityType: "contact", entityId: contactId, payload: { enrolled_by: "user" },
  });
}

const runs = (): MemoryRun[] => [...store.runs.values()];
const runsOf = (journeyId: string) => runs().filter((run) => run.journeyId === journeyId);
const only = (journeyId: string) => {
  const list = runsOf(journeyId);
  assert.equal(list.length, 1, `exactly one ${names.get(journeyId)} run`);
  return list[0];
};
const stepsAt = (run: MemoryRun, index: number) => store.stepsFor(run.id).filter((step) => step.nodeId === `${run.journeyId}-n${index}`);
const stepAt = (run: MemoryRun, index: number) => stepsAt(run, index).at(-1)!;

function retryLookups(): RunRetryLookups {
  return {
    async findRun(tenantId, runId) {
      const run = store.runs.get(runId);
      if (!run || run.tenantId !== tenantId) return null;
      return { journeyId: run.journeyId, contactId: run.contactId, status: run.status, currentNodeId: run.currentNodeId, context: structuredClone(run.context) };
    },
    async latestStep(tenantId, runId) {
      const step = store.steps.filter((entry) => entry.runId === runId && entry.tenantId === tenantId).at(-1);
      return step ? { nodeId: step.nodeId, nodeType: step.nodeType, status: step.status, error: step.error ?? null } : null;
    },
    journeyStatus: (tenantId, journeyId) => store.journeyStatus(tenantId, journeyId),
    hasActiveRun: (tenantId, journeyId, contactId) => store.hasActiveRun(tenantId, journeyId, contactId),
  };
}
const retry = (run: MemoryRun) => retryJourneyRun(store, retryLookups(), tenant, run.id, new Date(clock));

/** Runs a worker pass after `ms` more time has passed. */
async function worker(ms = 0) {
  advance(ms);
  return resumeDueRuns(deps);
}

// ---------- Contract ----------

describe("contract", () => {
  it("waitForCompletion is kept only when true; existing configs are unchanged", () => {
    const journeyId = randomUUID();
    assert.deepEqual(validateNodeConfig("action", { action: "start_journey", journeyId, waitForCompletion: true }, "strict"), {
      config: { action: "start_journey", journeyId, waitForCompletion: true },
      errors: [],
    });
    for (const waitForCompletion of [undefined, false, "true", 1, null]) {
      assert.deepEqual(validateNodeConfig("action", { action: "start_journey", journeyId, waitForCompletion }, "strict").config, { action: "start_journey", journeyId });
    }
  });
});

// ---------- Basic ----------

describe("basic", () => {
  it("without waiting, Start journey behaves as before: the parent continues and completes", async () => {
    const b = journey("B", "journey.started", [waitDay, task()]);
    const a = journey("A", "manual", [start(b), task("after")]);
    await enroll(a);
    assert.equal(only(a).status, "completed");
    assert.equal(only(b).status, "waiting");
    assert.deepEqual(stepAt(only(a), 0).output, { started: true, target_journey_id: b, run_id: only(b).id, causation_depth: 1 });
    assert.equal(only(a).context.waitingForChild, undefined);
    assert.deepEqual(performed, ["A:after"]);
  });

  it("with waiting: exactly one child; the parent parks at the step, unleased, not completed, and runs nothing after it", async () => {
    const b = journey("B", "journey.started", [waitDay, task()]);
    const a = journey("A", "manual", [callWait(b), task("after")]);

    await enroll(a);

    const parent = only(a);
    const child = only(b);
    assert.equal(parent.status, "waiting");
    assert.equal(parent.currentNodeId, `${a}-n0`);
    assert.equal(parent.completedAt, null);
    assert.equal(parent.lockedUntil, null, "no lease is held while waiting");
    assert.equal(parent.resumeAt, new Date(clock + CHILD_WAIT_RECHECK_MS).toISOString());
    const step = stepAt(parent, 0);
    assert.equal(step.status, "running");
    assert.deepEqual(step.output, { started: true, target_journey_id: b, run_id: child.id, causation_depth: 1, waiting: true });
    assert.deepEqual(parent.context.waitingForChild, { nodeId: `${a}-n0`, stepId: step.id, runId: child.id });
    assert.equal(child.status, "waiting", "the child runs on its own (it is at its Wait)");
    assert.deepEqual(performed, []);
  });

  it("an unconfigured option (existing step) never parks", async () => {
    const b = journey("B", "journey.started", [waitDay]);
    const a = journey("A", "manual", [{ action: "start_journey", journeyId: b, waitForCompletion: false }, task("after")]);
    await enroll(a);
    assert.equal(only(a).status, "completed");
  });
});

// ---------- Resume ----------

describe("resume", () => {
  it("a child that finishes in the same invocation lets the parent continue right away, at the next step", async () => {
    const b = journey("B", "journey.started", [task("child")]);
    const a = journey("A", "manual", [callWait(b), task("after")]);

    await enroll(a);

    const parent = only(a);
    assert.equal(parent.status, "completed");
    assert.deepEqual(performed, ["B:child", "A:after"]);
    assert.equal(stepsAt(parent, 0).length, 1, "the Start journey step ran once");
    assert.equal(stepAt(parent, 0).status, "completed");
    assert.deepEqual(stepAt(parent, 0).output, { started: true, target_journey_id: b, run_id: only(b).id, causation_depth: 1, child_status: "completed" });
    assert.equal(parent.context.waitingForChild, undefined);
    assert.equal(parent.lockedUntil, null);
  });

  it("a child that finishes later wakes the parent, which the worker then continues", async () => {
    const b = journey("B", "journey.started", [waitDay, task("child")]);
    const a = journey("A", "manual", [callWait(b), task("after")]);
    await enroll(a);

    await worker(DAY + 60_000);
    // The child finished and woke the parent: due now, not at its hourly recheck.
    assert.equal(only(b).status, "completed");
    assert.equal(only(a).status, "waiting");
    assert.ok(new Date(only(a).resumeAt!).getTime() <= clock);

    await worker();
    assert.equal(only(a).status, "completed");
    assert.deepEqual(performed, ["B:child", "A:after"]);
    assert.equal(stepsAt(only(a), 0).length, 1);
    assert.equal(runsOf(b).length, 1);
  });

  it("until the child finishes, a parent recheck only parks again (no new child, no step re-run)", async () => {
    const b = journey("B", "journey.started", [waitDay, task("child")]);
    const a = journey("A", "manual", [callWait(b), task("after")]);
    await enroll(a);

    for (let hour = 1; hour <= 3; hour++) {
      await worker(CHILD_WAIT_RECHECK_MS);
      const parent = only(a);
      assert.equal(parent.status, "waiting");
      assert.equal(parent.lockedUntil, null);
      assert.equal(parent.resumeAt, new Date(clock + CHILD_WAIT_RECHECK_MS).toISOString());
    }
    assert.equal(runsOf(b).length, 1);
    assert.equal(stepsAt(only(a), 0).length, 1);
    assert.deepEqual(performed, []);
  });

  it("a child's completion wakes only its own parent", async () => {
    const second = randomUUID();
    store.contacts.set(second, { tenantId: tenant, lead: { lead_status: "New" } });
    const b = journey("B", "journey.started", [waitDay, task("child")]);
    const a = journey("A", "manual", [callWait(b), task("after")]);
    await enroll(a);
    await enroll(a, second);
    const [p1, p2] = runsOf(a);
    const c1 = runsOf(b).find((run) => run.contactId === contact)!;
    const p2Due = p2.resumeAt;

    // Finish only the first child (claimRun ignores resume_at, so run it directly).
    store.runs.get(c1.id)!.lockedUntil = null;
    await executeRun(deps, c1.id);

    assert.equal(store.runs.get(c1.id)!.status, "completed");
    assert.ok(new Date(store.runs.get(p1.id)!.resumeAt!).getTime() <= clock, "own parent woken");
    assert.equal(store.runs.get(p2.id)!.resumeAt, p2Due, "the other parent isn't");
  });

  it("a wake for a different child, a non-waiting run, or another workspace changes nothing", async () => {
    const b = journey("B", "journey.started", [waitDay]);
    const a = journey("A", "manual", [callWait(b), task("after")]);
    await enroll(a);
    const parent = only(a);
    const due = parent.resumeAt;

    await store.wakeWaitingParent(tenant, parent.id, randomUUID(), new Date(clock));
    await store.wakeWaitingParent(randomUUID(), parent.id, only(b).id, new Date(clock));
    assert.equal(store.runs.get(parent.id)!.resumeAt, due);

    await store.wakeWaitingParent(tenant, parent.id, only(b).id, new Date(clock));
    assert.equal(store.runs.get(parent.id)!.resumeAt, new Date(clock).toISOString());
  });
});

// ---------- Failure and cancellation ----------

describe("child outcome", () => {
  it("a child that fails wakes the parent, which continues and can branch on child_status; it isn't failed itself", async () => {
    const b = journey("B", "journey.started", [task("child")]);
    failNextTask.add("B");
    const a = waitThenBranch("A", b);

    await enroll(a);

    assert.equal(only(b).status, "failed");
    const parent = only(a);
    assert.equal(parent.status, "completed");
    assert.equal(stepAt(parent, 0).output?.child_status, "failed");
    assert.deepEqual(performed, ["A:child not completed"]);
  });

  it("a child that completes takes the success branch", async () => {
    const b = journey("B", "journey.started", [task("child")]);
    await enroll(waitThenBranch("A", b));
    assert.deepEqual(performed, ["B:child", "A:ok"]);
  });

  it("a child cancelled because its journey was archived reports cancelled", async () => {
    const b = journey("B", "journey.started", [waitDay, task("child")]);
    const a = waitThenBranch("A", b);
    await enroll(a);
    store.setStatus(b, "archived");

    await worker(DAY);
    await worker();

    assert.equal(only(b).status, "cancelled");
    assert.equal(only(a).status, "completed");
    const parentStep = store.stepsFor(only(a).id).find((step) => step.nodeId === `${a}-n0`)!;
    assert.equal(parentStep.output?.child_status, "cancelled");
    assert.deepEqual(performed, ["A:child not completed"]);
  });

  it("a transient child failure doesn't wake the parent; the child's automatic retry keeps its inputs; the parent continues when it finishes", async () => {
    const b = journey("B", "journey.started", [task("child")]);
    failNextTaskTransient.add("B");
    const a = journey("A", "manual", [callWait(b, [{ target: "budget", source: "lead.budget" }]), task("after")]);

    await enroll(a);
    const child = only(b);
    assert.equal(child.status, "waiting", "child is retrying, not finished");
    assert.equal(only(a).status, "waiting");
    assert.ok(new Date(only(a).resumeAt!).getTime() > clock, "parent not woken");
    const payload = structuredClone(child.triggerPayload);
    store.contacts.get(contact)!.lead.budget = "CHANGED";

    await worker(RETRY_BACKOFF_MS[0]);
    assert.equal(only(b).status, "completed");
    assert.deepEqual(only(b).triggerPayload, payload);
    assert.deepEqual(only(b).triggerPayload.inputs, { budget: "500k" });

    await worker();
    assert.equal(only(a).status, "completed");
    assert.deepEqual(performed, ["B:child", "A:after"]);
  });

  it("the parent's journey paused while waiting: it stays paused, then resumes the wait (or continues) when reactivated", async () => {
    const b = journey("B", "journey.started", [waitDay, task("child")]);
    const a = journey("A", "manual", [callWait(b), task("after")]);
    await enroll(a);
    store.setStatus(a, "paused");

    await worker(DAY);
    assert.equal(only(b).status, "completed");
    assert.equal(only(a).status, "paused");
    assert.ok(only(a).context.waitingForChild, "the relationship survives the pause");

    // resumePausedRuns: waiting and due now.
    store.setStatus(a, "active");
    Object.assign(store.runs.get(only(a).id)!, { status: "waiting", resumeAt: new Date(clock).toISOString(), pausedAt: null });
    await worker();
    assert.equal(only(a).status, "completed");
    assert.deepEqual(performed, ["B:child", "A:after"]);
  });
});

// ---------- Crash and recovery ----------

describe("crash and recovery", () => {
  /** As if the pass died right after the child was created: step running, run mid-step, lease expired. */
  function crashedMidStep(parent: MemoryRun, index: number) {
    const live = store.runs.get(parent.id)!;
    const step = stepAt(live, index);
    const { child_status: _status, ...written } = step.output ?? {};
    step.status = "running";
    step.output = { ...written, waiting: true };
    Object.assign(live, {
      status: "running",
      currentNodeId: `${parent.journeyId}-n${index}`,
      lockedUntil: null,
      completedAt: null,
      resumeAt: new Date(clock).toISOString(),
      context: { steps: live.context.steps, attempts: {}, inFlight: { nodeId: `${parent.journeyId}-n${index}`, stepId: step.id } },
    });
  }

  it("died after creating the child but before parking: the repeated step finds the same child and parks on it", async () => {
    const b = journey("B", "journey.started", [waitDay, task("child")]);
    const a = journey("A", "manual", [callWait(b), task("after")]);
    await enroll(a);
    const child = only(b);
    crashedMidStep(only(a), 0);

    await worker();

    assert.equal(runsOf(b).length, 1, "no second child");
    const parent = only(a);
    assert.equal(parent.status, "waiting");
    assert.equal(parent.context.waitingForChild?.runId, child.id);
    assert.equal(stepAt(parent, 0).output?.duplicate, true);
    assert.equal(parent.lockedUntil, null);
  });

  it("died before parking and the child has since finished: the repeated step uses its outcome and continues", async () => {
    const b = journey("B", "journey.started", [task("child")]);
    failNextTask.add("B");
    const a = journey("A", "manual", [callWait(b), task("after")]);
    await enroll(a);
    performed = [];
    crashedMidStep(only(a), 0);

    await worker();

    assert.equal(runsOf(b).length, 1);
    assert.equal(only(a).status, "completed");
    assert.equal(stepAt(only(a), 0).output?.child_status, "failed");
    assert.deepEqual(performed, ["A:after"]);
  });

  it("died while waiting: nothing is held; the parent is still recovered by its recheck", async () => {
    const b = journey("B", "journey.started", [waitDay, task("child")]);
    const a = journey("A", "manual", [callWait(b), task("after")]);
    await enroll(a);
    assert.equal(only(a).lockedUntil, null);
    // The child finishes while no wake-up can reach the parent.
    const wake = store.wakeWaitingParent;
    store.wakeWaitingParent = async () => {
      throw new Error("process died");
    };
    await worker(DAY);
    store.wakeWaitingParent = wake;
    assert.equal(only(b).status, "completed");
    assert.equal(only(a).status, "waiting");

    await worker(CHILD_WAIT_RECHECK_MS);

    assert.equal(only(a).status, "completed");
    assert.deepEqual(performed, ["B:child", "A:after"]);
  });

  it("the child finished just before the parent parked (its wake-up found nothing waiting): the parent's post-park check makes it due now", async () => {
    const b = journey("B", "journey.started", [task("child")]);
    failNextTaskTransient.add("B");
    const a = journey("A", "manual", [callWait(b), task("after")]);
    await enroll(a);
    const child = only(b);
    assert.equal(child.status, "waiting");
    crashedMidStep(only(a), 0);

    // Another worker finishes the child while this one is about to park the parent.
    const update = store.updateRun.bind(store);
    let raced = false;
    store.updateRun = async (runId, lease, patch) => {
      if (!raced && runId === only(a).id && patch.status === "waiting") {
        raced = true;
        advance(RETRY_BACKOFF_MS[0]);
        await executeRun(deps, child.id);
        assert.equal(store.runs.get(child.id)!.status, "completed");
      }
      return update(runId, lease, patch);
    };
    await worker();
    store.updateRun = update;

    assert.ok(raced);
    assert.equal(only(a).status, "waiting");
    assert.ok(new Date(only(a).resumeAt!).getTime() <= clock, "due now, not at its hourly recheck");

    await worker();
    assert.equal(only(a).status, "completed");
    assert.deepEqual(performed, ["B:child", "A:after"]);
  });

  it("died after closing the wait step but before moving on: the next pass continues exactly once", async () => {
    const b = journey("B", "journey.started", [waitDay, task("child")]);
    const a = journey("A", "manual", [callWait(b), task("after")]);
    await enroll(a);
    await worker(DAY);
    assert.equal(only(b).status, "completed");

    const update = store.updateRun.bind(store);
    let crashed = false;
    store.updateRun = async (runId, lease, patch) => {
      if (!crashed && runId === only(a).id && patch.currentNodeId === `${a}-n1`) {
        crashed = true;
        throw new Error("process died");
      }
      return update(runId, lease, patch);
    };
    const first = await worker();
    assert.equal(first.errors, 1);
    assert.equal(only(a).status, "running", "left mid-pass under a lease that will expire");
    assert.ok(only(a).context.waitingForChild);

    await worker(LEASE_MS + 1000);

    assert.equal(only(a).status, "completed");
    assert.deepEqual(performed, ["B:child", "A:after"], "the next step ran once");
    assert.equal(runsOf(b).length, 1);
  });

  it("concurrent resumes: only one wins; the next step runs once", async () => {
    const b = journey("B", "journey.started", [waitDay, task("child")]);
    const a = journey("A", "manual", [callWait(b), task("after")]);
    await enroll(a);
    await worker(DAY);

    const outcomes = await Promise.all([executeRun(deps, only(a).id), executeRun(deps, only(a).id)]);

    assert.deepEqual(outcomes.map((outcome) => outcome.status).sort(), ["completed", "not_claimed"]);
    assert.equal(only(a).status, "completed");
    assert.deepEqual(performed, ["B:child", "A:after"]);
    assert.equal(stepsAt(only(a), 1).length, 1);
  });
});

// ---------- Idempotency and retry ----------

describe("idempotency and retry", () => {
  it("the child's run key is unchanged: journey.started:<parent run>:<node>:<target>", async () => {
    const b = journey("B", "journey.started", [waitDay]);
    const a = journey("A", "manual", [callWait(b, [{ target: "budget", source: "lead.budget" }])]);
    await enroll(a);
    assert.equal(only(b).idempotencyKey, `journey.started:${only(a).id}:${a}-n0:${b}`);
  });

  it("a waiting parent can't be retried: no second child, the wait and the child are untouched", async () => {
    const b = journey("B", "journey.started", [waitDay]);
    const a = journey("A", "manual", [callWait(b), task("after")]);
    await enroll(a);
    const before = structuredClone(only(a));

    const result = await retry(only(a));

    assert.deepEqual(result, { result: "blocked", reason: "not_failed", journeyId: a });
    assert.deepEqual(only(a), before);
    assert.equal(runsOf(b).length, 1);
  });

  it("a parent failed at the step after its child finished retries onto the existing child's outcome", async () => {
    const b = journey("B", "journey.started", [task("child")]);
    const a = journey("A", "manual", [callWait(b), task("after")]);
    await enroll(a);
    // As if the step had failed after the child was created (e.g. its bookkeeping failed for good).
    const live = store.runs.get(only(a).id)!;
    const step = stepAt(live, 0);
    store.steps = store.steps.filter((entry) => entry.runId !== live.id || entry.id === step.id);
    Object.assign(step, { status: "failed", error: "Journey store updateRun failed: timeout", errorKind: "transient" });
    Object.assign(live, { status: "failed", currentNodeId: `${a}-n0`, context: { steps: {}, attempts: {} }, completedAt: new Date(clock).toISOString() });
    performed = [];

    assert.equal((await retry(live)).result, "retried");
    await worker();

    assert.equal(runsOf(b).length, 1);
    assert.equal(only(a).status, "completed");
    assert.equal(stepAt(only(a), 0).output?.child_status, "completed");
    assert.deepEqual(performed, ["A:after"]);
  });

  it("a parent failed at a later step retries only that step; the wait isn't repeated", async () => {
    const b = journey("B", "journey.started", [task("child")]);
    const a = journey("A", "manual", [callWait(b), task("after")]);
    failNextTask.add("A");
    await enroll(a);
    assert.equal(only(a).status, "failed");

    assert.equal((await retry(only(a))).result, "retried");
    await worker();

    assert.equal(only(a).status, "completed");
    assert.equal(runsOf(b).length, 1);
    assert.equal(stepsAt(only(a), 0).length, 1);
    assert.deepEqual(performed, ["B:child", "A:after"]);
  });

  it("a child that failed and is retried by hand after the parent moved on doesn't wake or re-run the parent", async () => {
    const b = journey("B", "journey.started", [task("child")]);
    failNextTask.add("B");
    const a = journey("A", "manual", [callWait(b), task("after")]);
    await enroll(a);
    assert.equal(only(a).status, "completed");
    const parent = structuredClone(only(a));

    assert.deepEqual(await retry(only(b)), { result: "retried", journeyId: b });
    await worker();

    assert.equal(only(b).status, "completed");
    assert.deepEqual(only(a), parent);
    assert.deepEqual(performed, ["A:after", "B:child"]);
  });
});

// ---------- Inputs and isolation ----------

describe("inputs and isolation", () => {
  it("Stage 3 inputs reach the child; nothing of the child comes back but its run id and status", async () => {
    const b = randomUUID();
    aiOutputs.set(`${b}-n0`, { secret_score: 99 });
    journey("B", "journey.started", [aiStep(), task("child")], { id: b });
    const a = journey("A", "manual", [callWait(b, [{ target: "budget", source: "lead.budget" }]), task("after")]);

    await enroll(a);

    assert.deepEqual(only(b).triggerPayload.inputs, { budget: "500k" });
    const parent = only(a);
    const expected = ["causation_depth", "child_status", "run_id", "started", "target_journey_id"];
    assert.deepEqual(Object.keys(stepAt(parent, 0).output ?? {}).sort(), expected);
    const recorded = Object.values(parent.context.steps).find((entry) => entry.output?.run_id === only(b).id);
    assert.deepEqual(Object.keys(recorded?.output ?? {}).sort(), expected);
    const serialized = JSON.stringify([parent, store.stepsFor(parent.id)]);
    for (const leaked of ["secret_score", "child reasoning"]) assert.ok(!serialized.includes(leaked), leaked);
  });
});

// ---------- Lineage and causation ----------

describe("lineage and causation", () => {
  it("the child's lineage is Stage 2's; the parent's lineage and depth don't change by waiting", async () => {
    const b = journey("B", "journey.started", [task("child")]);
    const a = journey("A", "manual", [callWait(b), task("after")]);
    await enroll(a);
    const [parent, child] = [only(a), only(b)];
    assert.deepEqual(child.triggerPayload, { origin: "journey", origin_run_id: parent.id, origin_journey_id: a, root_run_id: parent.id, causation_depth: 1 });
    assert.deepEqual(parent.triggerPayload, { enrolled_by: "user" });
    assert.equal(runCausationDepth(parent), 1);
  });

  it("waiting doesn't use a causation level: after the wait, the parent's next child is at the same depth", async () => {
    const b = journey("B", "journey.started", [task("child")]);
    const c = journey("C", "journey.started", [task("c")]);
    const a = journey("A", "manual", [callWait(b), start(c)]);
    await enroll(a);
    assert.equal(only(b).triggerPayload.causation_depth, 1);
    assert.equal(only(c).triggerPayload.causation_depth, 1);
  });

  it("A waits B waits C: C can't start D (cap); every run finishes, inline, and no lease is left", async () => {
    const d = journey("D", "journey.started", [task("d")]);
    const c = journey("C", "journey.started", [callWait(d), task("c")]);
    const b = journey("B", "journey.started", [callWait(c), task("b")]);
    const a = journey("A", "manual", [callWait(b), task("a")]);

    await enroll(a);

    assert.equal(runsOf(d).length, 0);
    assert.equal(stepAt(only(c), 0).output?.skipped_reason, "depth_limited");
    assert.deepEqual([only(a), only(b), only(c)].map((run) => [run.status, run.lockedUntil]), [["completed", null], ["completed", null], ["completed", null]]);
    assert.deepEqual(performed, ["C:c", "B:b", "A:a"]);
    assert.deepEqual([only(b), only(c)].map((run) => run.triggerPayload.causation_depth), [1, 2]);
  });
});

// ---------- Cycles ----------

describe("cycles", () => {
  it("A waits for B, B waits for A: B finds A already active, skips without waiting, and both finish", async () => {
    const aId = randomUUID();
    const b = journey("B", "journey.started", [callWait(aId), task("b")]);
    journey("A", "journey.started", [callWait(b), task("a")], { id: aId });

    // A started by a journey.started event with no lineage: depth 1, so B (depth 2) can still dispatch.
    await dispatchJourneyEvent(deps, {
      tenantId: tenant, type: "journey.started", journeyId: aId, sourceId: randomUUID(), contactId: contact, entityType: "contact", entityId: contact, payload: {},
    });

    assert.equal(runsOf(aId).length, 1);
    assert.equal(runCausationDepth(only(b)), 2);
    assert.equal(runsOf(b).length, 1);
    assert.equal(stepAt(only(b), 0).output?.skipped_reason, "already_active");
    assert.equal(only(b).status, "completed");
    assert.equal(only(aId).status, "completed");
    assert.equal(stepAt(only(aId), 0).output?.child_status, "completed");
    assert.ok(runs().every((run) => run.lockedUntil === null && run.status === "completed"));
    assert.deepEqual(performed, ["B:b", "A:a"]);
  });

  it("A waits B waits C waits A: the chain stops at the cap; nothing is left waiting", async () => {
    const aId = randomUUID();
    const c = journey("C", "journey.started", [callWait(aId), task("c")]);
    const b = journey("B", "journey.started", [callWait(c), task("b")]);
    journey("A", "manual", [callWait(b), task("a")], { id: aId });

    await enroll(aId);

    assert.equal(runsOf(aId).length, 1);
    assert.ok(["depth_limited", "already_active"].includes(stepAt(only(c), 0).output?.skipped_reason as string));
    assert.ok(runs().every((run) => run.status === "completed" && run.lockedUntil === null));
  });

  it("a journey can't wait for itself (self_start), at activation or at runtime", async () => {
    const aId = randomUUID();
    journey("A", "manual", [callWait(aId), task("a")], { id: aId });
    await enroll(aId);
    assert.equal(stepAt(only(aId), 0).output?.skipped_reason, "self_start");
    assert.equal(only(aId).status, "completed");
  });
});

describe("Stage 2 skips still apply in wait mode, and never park", () => {
  it("a run without a contact skips and continues", async () => {
    const b = journey("B", "journey.started", [waitDay]);
    const a = journey("A", "manual", [callWait(b), task("after")]);
    await enroll(a, null);
    assert.equal(stepAt(only(a), 0).output?.skipped_reason, "no_contact");
    assert.equal(only(a).status, "completed");
    assert.equal(runsOf(b).length, 0);
  });

  it("inactive target, other workspace, target not listening: skipped, parent continues", async () => {
    const paused = journey("Paused", "journey.started", [task()]);
    store.setStatus(paused, "paused");
    const foreign = journey("Foreign", "journey.started", [task()], { tenantId: randomUUID() });
    const listening = journey("NotListening", "manual", [task()]);
    const a = journey("A", "manual", [callWait(paused), callWait(foreign), callWait(listening), task("after")]);

    await enroll(a);

    const parent = only(a);
    assert.equal(parent.status, "completed");
    assert.deepEqual([0, 1, 2].map((index) => stepAt(parent, index).output?.skipped_reason), ["target_inactive", "target_not_found", "target_not_listening"]);
    assert.deepEqual(performed, ["A:after"]);
  });
});
