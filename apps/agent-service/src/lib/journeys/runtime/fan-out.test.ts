/**
 * Start journeys (fan-out / fan-in): one step starts up to 10 journeys for the
 * lead, each exactly as a Start journey step would (own run key, lineage,
 * depth, inputs), and with waitForCompletion waits until every started child
 * is completed, failed, or cancelled (completion "all"), then records each
 * child's outcome and mapped results under output.children.<child key>. Real
 * engine, dispatcher, worker entry, run retry, and memory store.
 */

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { beforeEach, describe, it } from "node:test";
import type { JourneyAIExecutor } from "./ai.ts";
import { resolveField, type ExecutionContext } from "./conditions.ts";
import {
  fanOutChildKey,
  MAX_CHILD_JOURNEYS_PER_FANOUT,
  nodeReferenceKey,
  validateNodeConfig,
  type InputMapping,
  type ResultExport,
  type ResultMapping,
} from "./contracts.ts";
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
import { activationIssues, knownOutputFields, type JourneySnapshot, type SnapshotNode } from "./graph.ts";
import { MemoryJourneyStore, type MemoryRun } from "./memory-store.ts";
import { retryJourneyRun, type RunRetryLookups } from "./run-retry.ts";

const DAY = 24 * 60 * 60_000;

let store: MemoryJourneyStore;
let deps: EngineDeps;
let tenant: string;
let contact: string;
let clock: number;
let names: Map<string, string>;
let performed: string[];
let failNextTask: Set<string>;
let failNextTaskTransient: Set<string>;
let aiOutputs: Map<string, Record<string, unknown>>;

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
  store.contacts.set(contact, { tenantId: tenant, lead: { lead_status: "New", budget: "500k", target_location: "Austin" } });

  const ai: JourneyAIExecutor = {
    async execute(request) {
      return { success: true, output: structuredClone(aiOutputs.get(request.nodeId) ?? {}), text: "PRIVATE child reasoning" };
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

type Step = Record<string, unknown> & { type?: "action" | "ai" | "condition" };
const task = (title: string): Step => ({ action: "create_task", title, notes: "", dueInDays: 1 });
const aiStep = (): Step => ({ type: "ai", goal: "Decide", instructions: "", agent: "default" });
const waitDay: Step = { action: "wait", duration: 1, unit: "days" };
const kid = (journeyId: string, extra: { inputs?: InputMapping[]; results?: ResultMapping[] } = {}) => ({
  journeyId,
  ...(extra.inputs ? { inputMappings: extra.inputs } : {}),
  ...(extra.results ? { resultMappings: extra.results } : {}),
});
type Kid = ReturnType<typeof kid>;
const fan = (children: Array<string | Kid>, wait = true): Step => ({
  action: "start_journeys",
  journeys: children.map((child) => (typeof child === "string" ? kid(child) : child)),
  ...(wait ? { waitForCompletion: true, completion: "all" } : {}),
});
const receive = (target: string, name = target): ResultMapping => ({ target, source: `result.${name}` });
const out = (journeyId: string, index: number, field: string) => `steps.${nodeReferenceKey(`${journeyId}-n${index}`)}.output.${field}`;
const declare = (name: string, journeyId: string, index: number, field = name): ResultExport => ({ name, source: out(journeyId, index, field) });
const ck = fanOutChildKey;
/** steps.<fan-out node key>.output.children.<child key>.<field> of a parent whose fan-out is node n0. */
const childField = (parent: string, child: string, field: string) => out(parent, 0, `children.${ck(child)}.${field}`);

function journey(
  name: string,
  event: string,
  steps: Step[],
  { id = randomUUID(), tenantId = tenant, results }: { id?: string; tenantId?: string; results?: (id: string) => ResultExport[] } = {},
) {
  names.set(id, name);
  store.saveJourney(tenantId, id, snapshotOf(id, event, steps, results?.(id)));
  return id;
}

/** Trigger → steps in order; a condition's Yes path is the next step. */
function snapshotOf(id: string, event: string, steps: Step[], results?: ResultExport[]): JourneySnapshot {
  const nodes: SnapshotNode[] = [
    { id: `${id}-t`, type: "trigger", name: "Trigger", description: "", config: { event, filters: [], ...(results ? { results } : {}) } },
    ...steps.map(({ type = "action", ...config }, index): SnapshotNode => ({ id: `${id}-n${index}`, type, name: `Step ${index}`, description: "", config })),
  ];
  return {
    nodes,
    connections: nodes.slice(1).map((node, index) => ({ id: `${id}-c${index}`, sourceNodeId: nodes[index].id, targetNodeId: node.id, sourceHandle: null, targetHandle: null })),
  };
}

/** Manual trigger → fan-out → Condition (`rules`, logic) → task "yes" / task "no". */
function fanThenBranch(name: string, step: Step, condition: (id: string) => Record<string, unknown>) {
  const id = randomUUID();
  names.set(id, name);
  const node = (suffix: string, type: SnapshotNode["type"], config: Record<string, unknown>): SnapshotNode => ({ id: `${id}-${suffix}`, type, name: suffix, description: "", config });
  const link = (source: string, target: string, sourceHandle: string | null = null) => ({ id: `${source}>${target}`, sourceNodeId: `${id}-${source}`, targetNodeId: `${id}-${target}`, sourceHandle, targetHandle: null });
  store.saveJourney(tenant, id, {
    nodes: [node("t", "trigger", { event: "manual", filters: [] }), node("n0", "action", step), node("c", "condition", condition(id)), node("y", "action", task("yes")), node("n", "action", task("no"))],
    connections: [link("t", "n0"), link("n0", "c"), link("c", "y", "yes"), link("c", "n", "no")],
  });
  return id;
}

async function enroll(journeyId: string, contactId: string = contact) {
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
const fanOutput = (run: MemoryRun) => stepAt(run, 0).output as Record<string, unknown>;
const childOf = (run: MemoryRun, journeyId: string) => (fanOutput(run).children as Record<string, Record<string, unknown>>)[ck(journeyId)];

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

async function worker(ms = 0) {
  clock += ms;
  return resumeDueRuns(deps);
}

/** As if the pass died mid-step at the fan-out (node n0): run running and unleased, step still in flight. */
function crashedMidStep(parent: MemoryRun) {
  const live = store.runs.get(parent.id)!;
  const step = stepAt(live, 0);
  step.status = "running";
  Object.assign(live, {
    status: "running", currentNodeId: `${parent.journeyId}-n0`, lockedUntil: null, completedAt: null, error: null,
    resumeAt: new Date(clock).toISOString(),
    context: { steps: live.context.steps, attempts: {}, inFlight: { nodeId: `${parent.journeyId}-n0`, stepId: step.id } },
  });
}

const quick = (name: string) => journey(name, "journey.started", [task(name.toLowerCase())]);
const slow = (name: string, days = 1) => journey(name, "journey.started", [...Array.from({ length: days }, () => waitDay), task(name.toLowerCase())]);
/** AI step (n0) → task; returns `exports` of the AI step's output. */
function deciding(name: string, output: Record<string, unknown>, exports: string[]) {
  const id = randomUUID();
  aiOutputs.set(`${id}-n0`, output);
  return journey(name, "journey.started", [aiStep(), task(name.toLowerCase())], { id, results: (j) => exports.map((entry) => declare(entry, j, 0)) });
}

// ---------- Contract and validation ----------

describe("contract", () => {
  const fanStep = (config: Record<string, unknown>) => validateNodeConfig("action", { action: "start_journeys", ...config }, "strict");
  const ids = (count: number) => Array.from({ length: count }, () => ({ journeyId: randomUUID() }));

  it("1 to 10 distinct journeys with valid ids; waiting stores completion \"all\"", () => {
    const children = ids(2);
    const valid = fanStep({ journeys: children, waitForCompletion: true });
    assert.deepEqual(valid.errors, []);
    assert.deepEqual(valid.config, { action: "start_journeys", journeys: children, waitForCompletion: true, completion: "all" });
    assert.deepEqual(fanStep({ journeys: children }).config, { action: "start_journeys", journeys: children }, "no wait: no completion");
    assert.deepEqual(fanStep({ journeys: ids(MAX_CHILD_JOURNEYS_PER_FANOUT) }).errors, []);

    assert.deepEqual(fanStep({ journeys: [] }).errors, ["Add at least one journey to start."]);
    assert.deepEqual(fanStep({}).errors, ["Add at least one journey to start."]);
    assert.deepEqual(fanStep({ journeys: "x" }).errors, ["Journeys: the journey list is malformed."]);
    assert.deepEqual(fanStep({ journeys: ids(11) }).errors, ["Start at most 10 journeys."]);
    assert.equal((fanStep({ journeys: ids(11) }).config.journeys as unknown[]).length, 10, "never more than 10 kept");
    assert.deepEqual(fanStep({ journeys: [{ journeyId: "not-a-uuid" }] }).errors, ["Journey 1: choose the journey to start."]);
    assert.deepEqual(fanStep({ journeys: ["x"] }).errors, ["Journey 1 is malformed."]);
    const id = randomUUID();
    assert.deepEqual(fanStep({ journeys: [{ journeyId: id }, { journeyId: id.toUpperCase() }] }).errors, ["Journey 2: that journey is already started by this step."]);
    assert.deepEqual(fanStep({ journeys: ids(1), waitForCompletion: true, completion: "any" }).errors, ["Completion: only “All journeys finish” is supported."]);
  });

  it("each child has its own Stage 3 inputs and Stage 5 results (results need waiting); errors name the child", () => {
    const [a, b] = [randomUUID(), randomUUID()];
    const config = {
      journeys: [
        { journeyId: a, inputMappings: [{ target: "budget", source: "lead.budget" }], resultMappings: [receive("decision")] },
        { journeyId: b, inputMappings: [{ target: "city", source: "lead.target_location" }] },
      ],
      waitForCompletion: true,
    };
    assert.deepEqual(fanStep(config).errors, []);
    assert.deepEqual(fanStep({ ...config, waitForCompletion: undefined }).errors, [
      "Journey 1: Results: only a step that waits for the journeys to finish can receive results.",
    ]);
    assert.deepEqual(fanStep({ journeys: [{ journeyId: a, inputMappings: [{ target: "Bad", source: "lead.budget" }] }] }).errors, [
      "Journey 1: Input 1: use lowercase letters, numbers, and underscores, starting with a letter.",
    ]);
    assert.deepEqual(fanStep({ journeys: [{ journeyId: a, inputMappings: Array.from({ length: 11 }, (_, i) => ({ target: `v${i}`, source: "lead.budget" })) }] }).errors, [
      "Journey 1: Pass at most 10 inputs.",
    ]);
    assert.deepEqual(fanStep({ journeys: [{ journeyId: a, resultMappings: [{ target: "x", source: "steps.a.output.x" }] }], waitForCompletion: true }).errors, [
      "Journey 1: Result \"x\": choose a result the started journey returns.",
    ]);
  });

  it("activation: self-target, input sources, and (given the workspace's declarations) undeclared results are rejected per child", () => {
    const self = randomUUID();
    const [declaring, silent] = [randomUUID(), randomUUID()];
    const snapshot = snapshotOf(self, "manual", [
      fan([
        kid(self),
        kid(declaring, { results: [receive("decision"), receive("score")], inputs: [{ target: "x", source: out(self, 1, "late") }] }),
        kid(silent, { results: [receive("anything")] }),
      ]),
      task("after"),
    ]);
    const messages = activationIssues(snapshot, self, new Map([[declaring, ["decision"]]])).map((issue) => issue.message);
    assert.deepEqual(messages, [
      "\"Step 0\": Journey 1: a journey can't start itself.",
      "\"Step 0\": Journey 2: Input \"x\": \"Step 1\" doesn't run before this step on every path.",
      "\"Step 0\": Journey 2: Result \"score\": the started journey doesn't return \"score\".",
      "\"Step 0\": Journey 3: Result \"anything\": the started journey doesn't return \"anything\".",
    ]);
    assert.deepEqual(
      activationIssues(snapshotOf(self, "manual", [fan([kid(declaring, { results: [receive("decision")] })])]), self, new Map([[declaring, ["decision"]]])),
      [],
    );
  });

  it("the same declaration check now applies to a waiting Start journey step", () => {
    const self = randomUUID();
    const target = randomUUID();
    const snapshot = snapshotOf(self, "manual", [{ action: "start_journey", journeyId: target, waitForCompletion: true, resultMappings: [receive("decision")] }]);
    assert.deepEqual(activationIssues(snapshot, self), [], "without declarations: graph-only, as in Stage 5");
    assert.deepEqual(activationIssues(snapshot, self, new Map()).map((issue) => issue.message), [
      "\"Step 0\": Result \"decision\": the started journey doesn't return \"decision\".",
    ]);
    assert.deepEqual(activationIssues(snapshot, self, new Map([[target, ["decision"]]])), []);
  });

  it("conditions may read a configured child's status, skip reason, results error, or a result it maps; nothing else", () => {
    const self = randomUUID();
    const [a, b, other] = [randomUUID(), randomUUID(), randomUUID()];
    const withCondition = (field: string, step = fan([kid(a, { results: [receive("decision")] }), b])) =>
      activationIssues(snapshotOf(self, "manual", [step, { type: "condition", field, operator: "equals", value: "x" }, task("after")]), self).map((issue) => issue.message);

    for (const field of ["child_status", "skipped_reason", "results_error", "started", "results.decision"]) {
      assert.deepEqual(withCondition(childField(self, a, field)), [], field);
    }
    assert.deepEqual(withCondition(childField(self, b, "child_status")), []);
    assert.deepEqual(withCondition(out(self, 0, "results_error")), [], "the aggregate results error");

    assert.deepEqual(withCondition(childField(self, other, "child_status")), [
      `"Step 1": "Step 0" doesn't start that journey or doesn't record "child_status" for it.`,
    ]);
    assert.deepEqual(withCondition(childField(self, b, "results.decision")), [
      `"Step 1": "Step 0" doesn't start that journey or doesn't record "results.decision" for it.`,
    ]);
    assert.deepEqual(withCondition(childField(self, a, "results.score")), [
      `"Step 1": "Step 0" doesn't start that journey or doesn't record "results.score" for it.`,
    ]);
    // Arbitrary child data has no path at all.
    for (const field of ["run_id", "context", "steps", "trigger_payload", "results"]) {
      assert.deepEqual(withCondition(childField(self, a, field)), ['"Step 1": Condition: choose a field.'], field);
    }
    assert.deepEqual(withCondition(`${out(self, 0, "children")}.${a}.child_status`), ['"Step 1": Condition: choose a field.'], "raw uuid key");
    assert.deepEqual(withCondition(childField(self, a, "child_status"), task("not a fan-out")), [`"Step 1": "Step 0" isn't a Start journeys step.`]);
    assert.deepEqual(withCondition(childField(self, a, "results.decision"), fan([a, b], false)), [
      `"Step 1": "Step 0" doesn't start that journey or doesn't record "results.decision" for it.`,
    ], "no results without waiting");
  });

  it("known output fields list exactly the configured children's readable fields", () => {
    const [a, b] = [randomUUID(), randomUUID()];
    const node = { type: "action" as const, config: fan([kid(a, { results: [receive("decision")] }), b]) };
    assert.deepEqual(knownOutputFields(node), [
      "causation_depth", "completion", "results_error",
      `children.${ck(a)}.child_status`, `children.${ck(a)}.started`, `children.${ck(a)}.skipped_reason`, `children.${ck(a)}.results_error`, `children.${ck(a)}.results.decision`,
      `children.${ck(b)}.child_status`, `children.${ck(b)}.started`, `children.${ck(b)}.skipped_reason`, `children.${ck(b)}.results_error`,
    ]);
  });

  it("resolveField reads only own plain-object keys along children.<key>.…", () => {
    const a = randomUUID();
    const context = (children: unknown): ExecutionContext => ({ lead: null, opportunity: null, trigger: { event: "manual", payload: {} }, steps: { s: { output: { children } } } });
    const field = (name: string) => `steps.s.output.children.${ck(a)}.${name}`;
    const ctx = context({ [ck(a)]: { child_status: "completed", results: { decision: "approved" } } });
    assert.equal(resolveField(ctx, field("child_status")), "completed");
    assert.equal(resolveField(ctx, field("results.decision")), "approved");
    assert.equal(resolveField(ctx, field("results.constructor")), undefined);
    assert.equal(resolveField(context({}), field("child_status")), undefined);
    assert.equal(resolveField(context([1]), field("child_status")), undefined);
    assert.equal(resolveField(context({ [ck(a)]: { results: ["approved"] } }), field("results.decision")), undefined);
    assert.equal(resolveField(context(Object.create({ [ck(a)]: { child_status: "completed" } })), field("child_status")), undefined);
  });
});

// ---------- Fan-out ----------

describe("fan-out", () => {
  it("two children: both start (one run each), the parent waits for both, then continues once", async () => {
    const [b, c] = [quick("B"), quick("C")];
    const a = journey("A", "manual", [fan([b, c]), task("after")]);

    await enroll(a);

    const parent = only(a);
    assert.equal(parent.status, "completed");
    assert.equal(runsOf(b).length, 1);
    assert.equal(runsOf(c).length, 1);
    assert.deepEqual(performed.sort(), ["A:after", "B:b", "C:c"]);
    assert.equal(fanOutput(parent).completion, "all");
    assert.equal(childOf(parent, b).child_status, "completed");
    assert.equal(childOf(parent, b).run_id, only(b).id);
    assert.equal(childOf(parent, c).child_status, "completed");
    assert.equal(stepAt(parent, 0).status, "completed");
    assert.equal(parent.context.waitingForChildren, undefined, "no fan-out state left behind");
  });

  it("three children, and the maximum of ten", async () => {
    const three = [quick("B"), quick("C"), quick("D")];
    const a = journey("A", "manual", [fan(three), task("after")]);
    await enroll(a);
    assert.equal(only(a).status, "completed");
    for (const id of three) assert.equal(childOf(only(a), id).child_status, "completed");

    const ten = Array.from({ length: 10 }, (_, i) => quick(`K${i}`));
    const big = journey("Big", "manual", [fan(ten), task("after")]);
    await enroll(big);
    assert.equal(only(big).status, "completed");
    for (const id of ten) assert.equal(runsOf(id).length, 1);
    assert.equal(Object.keys(fanOutput(only(big)).children as object).length, 10);
  });

  it("a stored config over the limit, with duplicates or itself, still starts at most 10 distinct other journeys", async () => {
    const eleven = Array.from({ length: 11 }, (_, i) => quick(`K${i}`));
    const self = randomUUID();
    journey("A", "manual", [fan([eleven[0], eleven[0], self, ...eleven.slice(1)]), task("after")], { id: self });
    await enroll(self);

    const startedRuns = runs().filter((run) => run.journeyId !== self);
    // The first 10 rows are K0, K0, self, K1…K7: one duplicate dropped, self skipped.
    assert.equal(startedRuns.length, 8);
    for (const id of eleven.slice(8)) assert.equal(runsOf(id).length, 0);
    assert.equal(childOf(only(self), self).skipped_reason, "self_start");
    assert.equal(childOf(only(self), self).child_status, "not_started");
    assert.equal(runsOf(self).length, 1);
  });

  it("without waiting: children start and the parent continues at once", async () => {
    const [b, c] = [slow("B"), slow("C")];
    const a = journey("A", "manual", [fan([b, c], false), task("after")]);
    await enroll(a);

    assert.equal(only(a).status, "completed");
    assert.equal(only(b).status, "waiting");
    assert.equal(childOf(only(a), b).started, true);
    assert.equal(childOf(only(a), b).child_status, undefined);
    assert.equal(fanOutput(only(a)).completion, undefined);
    assert.deepEqual(performed, ["A:after"]);
  });

  it("skipped children are recorded with Stage 2 reasons; the others still start and are waited for", async () => {
    const ok = slow("OK");
    const paused = quick("Paused");
    store.setStatus(paused, "paused");
    const foreign = journey("Foreign", "journey.started", [task("x")], { tenantId: randomUUID() });
    const notListening = journey("Manual only", "manual", [task("x")]);
    const missing = randomUUID();
    const busy = slow("Busy");
    await dispatchJourneyEvent(deps, { tenantId: tenant, type: "journey.started", journeyId: busy, sourceId: randomUUID(), contactId: contact, entityType: "contact", entityId: contact, payload: {} });
    const unrelated = only(busy);
    const a = journey("A", "manual", [fan([ok, paused, foreign, notListening, missing, busy]), task("after")]);

    await enroll(a);
    assert.equal(only(a).status, "waiting");
    assert.deepEqual(only(a).context.waitingForChildren?.children, [{ journeyId: ok, runId: only(ok).id }], "never waits on a run it didn't create");

    await worker(DAY);
    await worker();
    assert.equal(only(a).status, "completed");
    const parent = only(a);
    assert.equal(childOf(parent, paused).skipped_reason, "target_inactive");
    assert.equal(childOf(parent, foreign).skipped_reason, "target_not_found");
    assert.equal(childOf(parent, notListening).skipped_reason, "target_not_listening");
    assert.equal(childOf(parent, missing).skipped_reason, "target_not_found");
    assert.equal(childOf(parent, busy).skipped_reason, "already_active");
    for (const id of [paused, foreign, notListening, missing, busy]) {
      assert.equal(childOf(parent, id).child_status, "not_started");
      assert.equal(childOf(parent, id).started, false);
    }
    assert.equal(childOf(parent, ok).child_status, "completed");
    assert.equal(runsOf(busy).length, 1, "the unrelated run isn't attached to or duplicated");
    assert.equal(store.runs.get(unrelated.id)!.triggerPayload.origin_run_id, undefined);
  });

  it("every child skipped: the waiting step completes immediately", async () => {
    const paused = quick("Paused");
    store.setStatus(paused, "paused");
    const a = journey("A", "manual", [fan([paused, randomUUID()]), task("after")]);
    await enroll(a);
    assert.equal(only(a).status, "completed");
    assert.deepEqual(performed, ["A:after"]);
  });
});

// ---------- Waiting ----------

describe("waiting", () => {
  it("all children active: the parent waits, unleased, with one entry per child and an hourly recheck", async () => {
    const [b, c] = [slow("B"), slow("C")];
    const a = journey("A", "manual", [fan([b, c]), task("after")]);
    await enroll(a);

    const parent = only(a);
    assert.equal(parent.status, "waiting");
    assert.equal(parent.lockedUntil, null);
    assert.deepEqual(parent.context.waitingForChildren?.children, [
      { journeyId: b, runId: only(b).id },
      { journeyId: c, runId: only(c).id },
    ]);
    assert.equal(parent.resumeAt, new Date(clock + CHILD_WAIT_RECHECK_MS).toISOString());
    assert.equal(stepAt(parent, 0).status, "running");
    assert.equal(fanOutput(parent).waiting, true);
  });

  it("the first child to finish wakes the parent, which parks again; the last one makes it continue", async () => {
    const [b, c] = [slow("B", 1), slow("C", 2)];
    const a = journey("A", "manual", [fan([b, c]), task("after")]);
    await enroll(a);

    await worker(DAY);
    assert.equal(only(b).status, "completed");
    assert.equal(only(c).status, "waiting");
    assert.ok(new Date(only(a).resumeAt!).getTime() <= clock, "B's finish woke the parent");
    await worker();
    assert.equal(only(a).status, "waiting", "one child finishing isn't enough: it parked again");
    assert.ok(new Date(only(a).resumeAt!).getTime() > clock);
    assert.ok(only(a).context.waitingForChildren);
    assert.equal(stepAt(only(a), 0).status, "running");
    assert.deepEqual(performed, ["B:b"]);

    await worker(DAY);
    await worker();
    assert.equal(only(a).status, "completed");
    assert.deepEqual(performed, ["B:b", "C:c", "A:after"]);
    assert.equal(stepsAt(only(a), 1).length, 1);
  });

  it("children finishing in the other order give the same result", async () => {
    const [b, c] = [slow("B", 2), slow("C", 1)];
    const a = journey("A", "manual", [fan([b, c]), task("after")]);
    await enroll(a);
    await worker(DAY);
    await worker();
    assert.equal(only(a).status, "waiting");
    await worker(DAY);
    await worker();
    assert.equal(only(a).status, "completed");
    assert.equal(childOf(only(a), b).child_status, "completed");
    assert.equal(childOf(only(a), c).child_status, "completed");
    assert.deepEqual(performed, ["C:c", "B:b", "A:after"]);
  });

  it("children finishing in the same worker batch: the parent continues exactly once", async () => {
    const [b, c, d] = [slow("B"), slow("C"), slow("D")];
    const a = journey("A", "manual", [fan([b, c, d]), task("after")]);
    await enroll(a);
    await worker(DAY);
    await worker();
    assert.equal(only(a).status, "completed");
    assert.deepEqual(performed.filter((entry) => entry === "A:after"), ["A:after"]);
  });

  it("children that finish before the parent parks (their wake-ups find nothing waiting): the post-park check makes it due now", async () => {
    const [b, c] = [slow("B"), slow("C")];
    const a = journey("A", "manual", [fan([b, c]), task("after")]);
    await enroll(a);
    // A worker repeats the step (no inline continuation); the children finish just before it parks.
    crashedMidStep(only(a));
    const update = store.updateRun.bind(store);
    let raced = false;
    store.updateRun = async (runId, lease, patch) => {
      if (!raced && patch.status === "waiting" && patch.context?.waitingForChildren) {
        raced = true;
        for (const id of [b, c]) {
          const child = runsOf(id)[0];
          Object.assign(store.runs.get(child.id)!, { status: "completed", completedAt: new Date(clock).toISOString(), resumeAt: null });
        }
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
  });

  it("a lost wake-up is recovered by the hourly recheck", async () => {
    const [b, c] = [slow("B"), slow("C")];
    const a = journey("A", "manual", [fan([b, c]), task("after")]);
    await enroll(a);
    const wake = store.wakeWaitingParent;
    store.wakeWaitingParent = async () => {
      throw new Error("process died");
    };
    await worker(DAY);
    store.wakeWaitingParent = wake;
    assert.equal(only(b).status, "completed");
    assert.equal(only(c).status, "completed");
    assert.equal(only(a).status, "waiting");

    await worker(CHILD_WAIT_RECHECK_MS);
    assert.equal(only(a).status, "completed");
    assert.deepEqual(performed.filter((entry) => entry === "A:after"), ["A:after"]);
  });
});

// ---------- Outcomes ----------

describe("outcomes", () => {
  it("one child failed: recorded as failed; the parent continues, not failed", async () => {
    const [b, c] = [quick("B"), quick("C")];
    failNextTask.add("C");
    const a = journey("A", "manual", [fan([b, c]), task("after")]);
    await enroll(a);
    assert.equal(only(c).status, "failed");
    assert.equal(only(a).status, "completed");
    assert.equal(childOf(only(a), b).child_status, "completed");
    assert.equal(childOf(only(a), c).child_status, "failed");
    assert.ok(performed.includes("A:after"));
  });

  it("one child cancelled by a member (wakes the parent), one archived, several failed: all recorded, parent continues", async () => {
    const [cancelled, archived, failedOne, failedTwo, fine] = [slow("Cancelled"), slow("Archived"), quick("F1"), quick("F2"), slow("Fine")];
    failNextTask.add("F1");
    failNextTask.add("F2");
    const a = journey("A", "manual", [fan([cancelled, archived, failedOne, failedTwo, fine]), task("after")]);
    await enroll(a);
    assert.equal(only(a).status, "waiting");

    // What cancelJourneyRun does: cancel, then wake the run's origin.
    const child = store.runs.get(only(cancelled).id)!;
    Object.assign(child, { status: "cancelled", resumeAt: null, completedAt: new Date(clock).toISOString() });
    await store.wakeWaitingParent(tenant, only(a).id, child.id, new Date(clock));
    assert.ok(new Date(only(a).resumeAt!).getTime() <= clock, "the cancel woke the parent");
    await worker();
    assert.equal(only(a).status, "waiting", "others still running");

    store.setStatus(archived, "archived");
    await worker(DAY);
    await worker();
    const parent = only(a);
    assert.equal(parent.status, "completed");
    assert.equal(childOf(parent, cancelled).child_status, "cancelled");
    assert.equal(childOf(parent, archived).child_status, "cancelled");
    assert.equal(childOf(parent, failedOne).child_status, "failed");
    assert.equal(childOf(parent, failedTwo).child_status, "failed");
    assert.equal(childOf(parent, fine).child_status, "completed");
    assert.deepEqual(performed.filter((entry) => entry.startsWith("A:")), ["A:after"]);
  });

  it("a child's transient failure doesn't wake the parent; its retry keeps its inputs", async () => {
    const b = journey("B", "journey.started", [task("b")]);
    failNextTaskTransient.add("B");
    const a = journey("A", "manual", [fan([kid(b, { inputs: [{ target: "budget", source: "lead.budget" }] })]), task("after")]);
    await enroll(a);
    assert.equal(only(b).status, "waiting");
    assert.equal(only(a).status, "waiting");
    store.contacts.get(contact)!.lead.budget = "CHANGED";
    await worker(RETRY_BACKOFF_MS[0]);
    await worker();
    assert.equal(only(a).status, "completed");
    assert.deepEqual(only(b).triggerPayload.inputs, { budget: "500k" });
  });
});

// ---------- Results ----------

describe("results", () => {
  it("each child's mapped results stay under that child", async () => {
    const b = deciding("B", { decision: "approved", score: 0.91 }, ["decision", "score"]);
    const c = deciding("C", { decision: "declined", score: 0.2 }, ["decision", "score"]);
    const a = journey("A", "manual", [fan([kid(b, { results: [receive("decision")] }), kid(c, { results: [receive("c_score", "score")] })]), task("after")]);
    await enroll(a);

    const parent = only(a);
    assert.deepEqual(childOf(parent, b).results, { decision: "approved" });
    assert.deepEqual(childOf(parent, c).results, { c_score: 0.2 });
    assert.equal(fanOutput(parent).decision, undefined, "never flattened into the step");
    assert.equal(fanOutput(parent).results, undefined);
  });

  it("missing → null; capture errors and undeclared names stay on their own child; others are unaffected", async () => {
    const missing = deciding("Missing", {}, ["decision"]);
    const invalid = deciding("Invalid", { decision: { nested: true } }, ["decision"]);
    const listy = deciding("Listy", { decision: ["a"] }, ["decision"]);
    const undeclared = deciding("Undeclared", { decision: "x", secret: "s" }, ["decision"]);
    const fine = deciding("Fine", { decision: "ok" }, ["decision"]);
    const a = journey("A", "manual", [
      fan([missing, invalid, listy, undeclared, fine].map((id) => kid(id, { results: [receive("decision", id === undeclared ? "secret" : "decision")] }))),
      task("after"),
    ]);
    await enroll(a);

    const parent = only(a);
    assert.deepEqual(childOf(parent, missing).results, { decision: null });
    assert.equal(childOf(parent, missing).results_error, undefined);
    assert.deepEqual(childOf(parent, invalid).results, {});
    assert.equal(childOf(parent, invalid).results_error, "results_invalid");
    assert.equal(childOf(parent, listy).results_error, "results_invalid");
    assert.deepEqual(childOf(parent, undeclared).results, {});
    assert.equal(childOf(parent, undeclared).results_error, "results_not_exported");
    assert.deepEqual(childOf(parent, fine).results, { decision: "ok" });
    assert.equal(fanOutput(parent).results_error, undefined);
    assert.equal(parent.status, "completed");
    assert.ok(!JSON.stringify(fanOutput(parent)).includes("\"s\""), "an undeclared value never crosses");
  });

  it("a failed or cancelled child returns no results", async () => {
    const id = randomUUID();
    aiOutputs.set(`${id}-n0`, { decision: "approved" });
    journey("B", "journey.started", [aiStep(), task("b")], { id, results: (b) => [declare("decision", b, 0)] });
    failNextTask.add("B");
    const a = journey("A", "manual", [fan([kid(id, { results: [receive("decision")] })]), task("after")]);
    await enroll(a);
    assert.equal(childOf(only(a), id).child_status, "failed");
    assert.deepEqual(childOf(only(a), id).results, {});
    assert.equal(childOf(only(a), id).results_error, undefined);
  });

  it("all children's results together over 8 KB: none returned (results_too_large), never partial", async () => {
    const big = "x".repeat(5000);
    const b = deciding("B", { note: big }, ["note"]);
    const c = deciding("C", { note: big }, ["note"]);
    const d = deciding("D", { decision: "x" }, []);
    const a = journey("A", "manual", [fan([kid(b, { results: [receive("note")] }), kid(c, { results: [receive("note")] }), d]), task("after")]);
    await enroll(a);

    const parent = only(a);
    assert.equal(fanOutput(parent).results_error, "results_too_large");
    for (const id of [b, c]) {
      assert.deepEqual(childOf(parent, id).results, {});
      assert.equal(childOf(parent, id).results_error, "results_too_large");
      assert.equal(childOf(parent, id).child_status, "completed");
    }
    assert.equal(childOf(parent, d).results, undefined, "a child with no mappings has no results field");
    assert.equal(parent.status, "completed");
    assert.ok(JSON.stringify(fanOutput(parent)).length < 8192);
  });

  it("nothing of a child crosses but its status and mapped results: no context, reasoning, inputs, or step outputs", async () => {
    const b = deciding("B", { decision: "approved", internal: "PRIVATE-VALUE" }, ["decision"]);
    const c = journey("C", "journey.started", [task("c")]);
    const a = journey("A", "manual", [
      fan([kid(b, { results: [receive("decision")], inputs: [{ target: "budget", source: "lead.budget" }] }), kid(c, { inputs: [{ target: "city", source: "lead.target_location" }] })]),
      task("after"),
    ]);
    await enroll(a);
    assert.equal(only(b).status, "completed");
    assert.equal(only(c).status, "completed");

    const parent = only(a);
    const serialized = JSON.stringify({ step: fanOutput(parent), context: parent.context });
    for (const leaked of ["PRIVATE", "internal", "budget", "city", "500k", "Austin", "inputs", "origin"]) {
      assert.ok(!serialized.includes(leaked), `no ${leaked}`);
    }
    assert.deepEqual(Object.keys(childOf(parent, b)).sort(), ["child_status", "results", "run_id", "started", "target_journey_id"]);
    assert.deepEqual(Object.keys(childOf(parent, c)).sort(), ["child_status", "run_id", "started", "target_journey_id"]);
  });

  it("results are a snapshot: the child's lead changing later doesn't change what the parent received", async () => {
    const id = randomUUID();
    aiOutputs.set(`${id}-n0`, { decision: "approved" });
    journey("B", "journey.started", [aiStep(), task("b")], { id, results: (b) => [declare("decision", b, 0)] });
    const slowSibling = slow("C");
    const a = journey("A", "manual", [fan([kid(id, { results: [receive("decision")] }), slowSibling]), task("after")]);
    await enroll(a);
    assert.equal(only(id).status, "completed");
    aiOutputs.set(`${id}-n0`, { decision: "CHANGED" });
    store.contacts.get(contact)!.lead.lead_status = "Lost";
    await worker(DAY);
    await worker();
    assert.equal(only(a).status, "completed");
    assert.deepEqual(childOf(only(a), id).results, { decision: "approved" });
  });
});

// ---------- Conditions ----------

describe("conditions", () => {
  it("branch on one child's status: completed → yes; failed → no", async () => {
    const [b, c] = [quick("B"), quick("C")];
    failNextTask.add("C");
    const yes = fanThenBranch("A", fan([b, c]), (id) => ({ field: childField(id, b, "child_status"), operator: "equals", value: "completed" }));
    await enroll(yes);
    assert.ok(performed.includes("A:yes"));

    performed = [];
    const [d, e] = [quick("D"), quick("E")];
    failNextTask.add("E");
    const no = fanThenBranch("A2", fan([d, e]), (id) => ({ field: childField(id, e, "child_status"), operator: "equals", value: "completed" }));
    await enroll(no);
    assert.ok(performed.includes("A2:no"));
  });

  it("\"all completed\" and \"any failed\" with the existing all/any rules", async () => {
    const [b, c] = [quick("B"), quick("C")];
    failNextTask.add("C");
    const any = fanThenBranch("Any", fan([b, c]), (id) => ({
      logic: "any",
      rules: [b, c].map((child) => ({ field: childField(id, child, "child_status"), operator: "equals", value: "failed" })),
    }));
    await enroll(any);
    assert.ok(performed.includes("Any:yes"), "any failed");

    performed = [];
    const [d, e] = [quick("D"), quick("E")];
    const all = fanThenBranch("All", fan([d, e]), (id) => ({
      logic: "all",
      rules: [d, e].map((child) => ({ field: childField(id, child, "child_status"), operator: "equals", value: "completed" })),
    }));
    await enroll(all);
    assert.ok(performed.includes("All:yes"), "all completed");
  });

  it("branch on a child's result, and on it being empty", async () => {
    const b = deciding("B", { decision: "approved" }, ["decision"]);
    const yes = fanThenBranch("A", fan([kid(b, { results: [receive("decision")] })]), (id) => ({ field: childField(id, b, "results.decision"), operator: "equals", value: "approved" }));
    await enroll(yes);
    assert.ok(performed.includes("A:yes"));

    performed = [];
    const c = deciding("C", {}, ["decision"]);
    const empty = fanThenBranch("E", fan([kid(c, { results: [receive("decision")] })]), (id) => ({ field: childField(id, c, "results.decision"), operator: "is_empty", value: null }));
    await enroll(empty);
    assert.ok(performed.includes("E:yes"));
  });
});

// ---------- Inputs ----------

describe("inputs", () => {
  it("each child gets only its own inputs; one source can feed several children", async () => {
    const [b, c, d] = [quick("B"), quick("C"), quick("D")];
    const a = journey("A", "manual", [
      fan([
        kid(b, { inputs: [{ target: "budget", source: "lead.budget" }] }),
        kid(c, { inputs: [{ target: "where", source: "lead.target_location" }, { target: "money", source: "lead.budget" }] }),
        d,
      ]),
      task("after"),
    ]);
    await enroll(a);

    assert.deepEqual(only(b).triggerPayload.inputs, { budget: "500k" });
    assert.deepEqual(only(c).triggerPayload.inputs, { where: "Austin", money: "500k" });
    assert.equal(Object.hasOwn(only(d).triggerPayload, "inputs"), false);
  });

  it("one child's invalid inputs skip only that child", async () => {
    const [b, c] = [quick("B"), quick("C")];
    store.contacts.get(contact)!.lead.budget = { object: true };
    const a = journey("A", "manual", [fan([kid(b, { inputs: [{ target: "budget", source: "lead.budget" }] }), c]), task("after")]);
    await enroll(a);
    assert.equal(childOf(only(a), b).skipped_reason, "inputs_invalid");
    assert.equal(runsOf(b).length, 0);
    assert.equal(childOf(only(a), c).child_status, "completed");
  });
});

// ---------- Crash and recovery, idempotency ----------

describe("crash and recovery", () => {
  /** createRun dies on its `n`th call (a process crash mid-fan-out, as the engine sees it: an unexpected error). */
  function dieOnCreate(n: number) {
    const create = store.createRun.bind(store);
    let calls = 0;
    store.createRun = async (input) => {
      calls++;
      if (calls === n) throw new Error("process died");
      return create(input);
    };
    return () => (store.createRun = create);
  }

  it("no children created yet: the retried step creates all of them", async () => {
    const [b, c] = [slow("B"), slow("C")];
    const a = journey("A", "manual", [fan([b, c]), task("after")]);
    const restore = dieOnCreate(2); // call 1 is A's own run
    await enroll(a);
    restore();
    assert.equal(runsOf(b).length + runsOf(c).length, 0);
    assert.equal(only(a).status, "waiting", "transient: retried after backoff");

    await worker(RETRY_BACKOFF_MS[0]);
    assert.equal(runsOf(b).length, 1);
    assert.equal(runsOf(c).length, 1);
    assert.equal(only(a).status, "waiting");
  });

  it("one child created, then the step failed: the retry reuses it and creates only the missing one", async () => {
    const [b, c, d] = [slow("B"), slow("C"), slow("D")];
    const a = journey("A", "manual", [fan([b, c, d]), task("after")]);
    const restore = dieOnCreate(3);
    await enroll(a);
    restore();
    const first = only(b);
    assert.equal(runsOf(c).length, 0);

    await worker(RETRY_BACKOFF_MS[0]);
    assert.equal(only(b).id, first.id, "reused, not duplicated");
    assert.equal(runsOf(c).length, 1);
    assert.equal(runsOf(d).length, 1);
    assert.equal(childOf(only(a), b).duplicate, true);
    await worker(DAY);
    await worker();
    assert.equal(only(a).status, "completed");
    assert.deepEqual(performed.filter((entry) => entry === "A:after"), ["A:after"]);
  });

  it("died after some children were created (the pass crashed mid-step): the repeated step reuses them and creates the rest", async () => {
    const [b, c, d] = [slow("B"), slow("C"), slow("D")];
    const a = journey("A", "manual", [fan([b, c, d]), task("after")]);
    const restore = dieOnCreate(4);
    await enroll(a);
    restore();
    const [first, second] = [only(b), only(c)];
    crashedMidStep(only(a));

    await worker();
    assert.equal(only(b).id, first.id);
    assert.equal(only(c).id, second.id);
    assert.equal(runsOf(d).length, 1);
    assert.equal(only(a).status, "waiting");
    assert.equal(only(a).context.waitingForChildren?.children.length, 3);
  });

  it("died after all children were created but before parking: the repeated step reuses all and parks on them", async () => {
    const [b, c] = [slow("B"), slow("C")];
    const a = journey("A", "manual", [fan([b, c]), task("after")]);
    await enroll(a);
    const ids = [only(b).id, only(c).id];
    crashedMidStep(only(a));

    await worker();
    assert.deepEqual([only(b).id, only(c).id], ids);
    assert.equal(only(a).status, "waiting");
    assert.deepEqual(only(a).context.waitingForChildren?.children.map((child) => child.runId), ids);
  });

  it("died after every child finished but before the parent advanced: the next pass completes the step once", async () => {
    const [b, c] = [slow("B"), slow("C")];
    const a = journey("A", "manual", [fan([b, c]), task("after")]);
    await enroll(a);
    const update = store.updateRun.bind(store);
    let crashed = false;
    store.updateRun = async (runId, lease, patch) => {
      if (!crashed && runId === only(a).id && patch.currentNodeId === `${a}-n1`) {
        crashed = true;
        throw new Error("process died");
      }
      return update(runId, lease, patch);
    };
    await worker(DAY);
    await worker();
    assert.ok(crashed);
    assert.equal(only(a).status, "running", "left mid-pass under a lease that will expire");
    assert.ok(only(a).context.waitingForChildren);
    store.updateRun = update;

    await worker(LEASE_MS + 1000);
    assert.equal(only(a).status, "completed");
    assert.deepEqual(performed.filter((entry) => entry === "A:after"), ["A:after"]);
    assert.equal(runsOf(b).length + runsOf(c).length, 2);
  });

  it("concurrent resumes: one wins; the step completes and the next step runs once", async () => {
    const [b, c] = [slow("B"), slow("C")];
    const a = journey("A", "manual", [fan([b, c]), task("after")]);
    await enroll(a);
    const wake = store.wakeWaitingParent;
    store.wakeWaitingParent = async () => {};
    await worker(DAY);
    store.wakeWaitingParent = wake;

    const outcomes = await Promise.all([executeRun(deps, only(a).id), executeRun(deps, only(a).id), executeRun(deps, only(a).id)]);
    assert.deepEqual(outcomes.map((outcome) => outcome.status).sort(), ["completed", "not_claimed", "not_claimed"]);
    assert.deepEqual(performed.filter((entry) => entry === "A:after"), ["A:after"]);
    assert.equal(stepsAt(only(a), 1).length, 1);
  });

  it("redelivery of a child's wake-up and repeated executions after completion change nothing", async () => {
    const [b, c] = [quick("B"), quick("C")];
    const a = journey("A", "manual", [fan([b, c]), task("after")]);
    await enroll(a);
    const output = structuredClone(fanOutput(only(a)));
    await store.wakeWaitingParent(tenant, only(a).id, only(b).id, new Date(clock));
    await executeRun(deps, only(a).id);
    await worker(CHILD_WAIT_RECHECK_MS);
    assert.deepEqual(fanOutput(only(a)), output);
    assert.equal(runsOf(b).length + runsOf(c).length, 2);
    assert.deepEqual(performed.filter((entry) => entry === "A:after"), ["A:after"]);
  });

  it("a parent retried after a later step failed doesn't re-run the fan-out: no new children, same recorded results", async () => {
    const b = deciding("B", { decision: "approved" }, ["decision"]);
    const a = journey("A", "manual", [fan([kid(b, { results: [receive("decision")] })]), task("after")]);
    failNextTask.add("A");
    await enroll(a);
    assert.equal(only(a).status, "failed");
    const output = structuredClone(fanOutput(only(a)));
    aiOutputs.set(`${b}-n0`, { decision: "CHANGED" });

    const retried = await retryJourneyRun(store, retryLookups(), tenant, only(a).id, new Date(clock));
    assert.equal(retried.result, "retried");
    await worker();
    assert.equal(only(a).status, "completed");
    assert.equal(runsOf(b).length, 1);
    assert.deepEqual(fanOutput(only(a)), output);
    assert.equal(stepsAt(only(a), 0).length, 1);
  });
});

// ---------- Pause, cancel ----------

describe("pause and cancel", () => {
  it("the parent's journey paused while waiting: the fan-out state survives; children run on; reactivation continues", async () => {
    const [b, c] = [slow("B"), slow("C")];
    const a = journey("A", "manual", [fan([b, c]), task("after")]);
    await enroll(a);
    store.setStatus(a, "paused");
    store.runs.get(only(a).id)!.resumeAt = new Date(clock).toISOString();
    await worker();
    assert.equal(only(a).status, "paused");

    await worker(DAY);
    assert.equal(only(b).status, "completed");
    assert.equal(only(c).status, "completed");
    assert.equal(only(a).status, "paused");
    assert.equal(only(a).context.waitingForChildren?.children.length, 2);

    store.setStatus(a, "active");
    Object.assign(store.runs.get(only(a).id)!, { status: "waiting", resumeAt: new Date(clock).toISOString(), pausedAt: null });
    await worker();
    assert.equal(only(a).status, "completed");
    assert.deepEqual(performed.filter((entry) => entry === "A:after"), ["A:after"]);
  });

  it("paused, then reactivated before the children finish: it parks again", async () => {
    const [b, c] = [slow("B"), slow("C", 2)];
    const a = journey("A", "manual", [fan([b, c]), task("after")]);
    await enroll(a);
    store.setStatus(a, "paused");
    store.runs.get(only(a).id)!.resumeAt = new Date(clock).toISOString();
    await worker();
    store.setStatus(a, "active");
    Object.assign(store.runs.get(only(a).id)!, { status: "waiting", resumeAt: new Date(clock).toISOString(), pausedAt: null });
    await worker();
    assert.equal(only(a).status, "waiting");
    await worker(DAY);
    await worker();
    assert.equal(only(a).status, "waiting");
    await worker(DAY);
    await worker();
    assert.equal(only(a).status, "completed");
  });

  it("cancelling the parent doesn't cancel its children", async () => {
    const [b, c] = [slow("B"), slow("C")];
    const a = journey("A", "manual", [fan([b, c]), task("after")]);
    await enroll(a);
    Object.assign(store.runs.get(only(a).id)!, { status: "cancelled", resumeAt: null });

    await worker(DAY);
    assert.equal(only(b).status, "completed");
    assert.equal(only(c).status, "completed");
    assert.equal(only(a).status, "cancelled");
    assert.ok(!performed.includes("A:after"));
  });
});

// ---------- Security and isolation ----------

describe("security", () => {
  it("each contact's parent is satisfied only by its own children", async () => {
    const other = randomUUID();
    store.contacts.set(other, { tenantId: tenant, lead: { lead_status: "New" } });
    const [b, c] = [slow("B"), slow("C", 2)];
    const a = journey("A", "manual", [fan([b, c]), task("after")]);
    await enroll(a);
    await enroll(a, other);
    const parents = runsOf(a);
    const mine = parents.find((run) => run.contactId === contact)!;
    const theirs = parents.find((run) => run.contactId === other)!;
    // The other contact's children finish early.
    for (const run of runs().filter((entry) => entry.contactId === other && entry.journeyId !== a)) {
      Object.assign(store.runs.get(run.id)!, { status: "completed", resumeAt: null });
      await store.wakeWaitingParent(tenant, mine.id, run.id, new Date(clock));
      await store.wakeWaitingParent(tenant, theirs.id, run.id, new Date(clock));
    }
    await worker();
    assert.equal(store.runs.get(theirs.id)!.status, "completed");
    assert.equal(store.runs.get(mine.id)!.status, "waiting", "another contact's runs can't satisfy this fan-in");
    assert.ok(new Date(store.runs.get(mine.id)!.resumeAt!).getTime() > clock);
  });

  it("forged wake-ups (unknown run, other workspace, another step's child) don't make the parent due", async () => {
    const [b, c] = [slow("B"), slow("C")];
    const single = slow("S");
    const a = journey("A", "manual", [{ action: "start_journey", journeyId: single }, fan([b, c]), task("after")]);
    await enroll(a);
    const parent = only(a);
    const before = parent.resumeAt;
    await store.wakeWaitingParent(tenant, parent.id, randomUUID(), new Date(clock));
    await store.wakeWaitingParent(randomUUID(), parent.id, only(b).id, new Date(clock));
    await store.wakeWaitingParent(tenant, parent.id, only(single).id, new Date(clock));
    assert.equal(store.runs.get(parent.id)!.resumeAt, before);
    await store.wakeWaitingParent(tenant, parent.id, only(b).id, new Date(clock));
    assert.equal(store.runs.get(parent.id)!.resumeAt, new Date(clock).toISOString(), "the real child does");
    await worker();
    assert.equal(only(a).status, "waiting", "and the parent re-reads its children instead of trusting the wake-up");
  });

  it("forged results don't count: a child's step output named results/children, or stored context, can't set another child's values", async () => {
    const id = randomUUID();
    aiOutputs.set(`${id}-n0`, { decision: "real", results: { decision: "forged" }, children: { x: 1 } });
    journey("B", "journey.started", [aiStep(), task("b")], { id, results: (b) => [declare("decision", b, 0)] });
    const c = slow("C");
    const a = journey("A", "manual", [fan([kid(id, { results: [receive("decision")] }), c]), task("after")]);
    await enroll(a);
    // Tamper with the waiting step's recorded record of C: it still can't change what C reports.
    const recorded = stepAt(only(a), 0);
    (recorded.output!.children as Record<string, Record<string, unknown>>)[ck(c)] = { started: true, child_status: "failed", results: { decision: "forged" } };
    await worker(DAY);
    await worker();
    assert.equal(only(a).status, "completed");
    assert.deepEqual(childOf(only(a), id).results, { decision: "real" });
    assert.equal(childOf(only(a), c).results, undefined, "C maps no results, so none are recorded whatever the stored record says");
    assert.equal(childOf(only(a), c).child_status, "completed", "status comes from C's run, not the stored record");
  });

  it("results named like lineage fields can't change the parent's depth, lineage, or later dispatch", async () => {
    const b = deciding("B", { causation_depth: 0, origin_run_id: "forged", root_run_id: "forged" }, ["causation_depth", "origin_run_id", "root_run_id"]);
    const d = quick("D");
    const a = journey("A", "manual", [fan([kid(b, { results: [receive("causation_depth"), receive("origin_run_id"), receive("root_run_id")] })]), { action: "start_journey", journeyId: d }]);
    await enroll(a);
    assert.deepEqual(childOf(only(a), b).results, { causation_depth: 0, origin_run_id: "forged", root_run_id: "forged" });
    assert.equal(runCausationDepth(only(a)), 1);
    assert.equal(only(d).triggerPayload.causation_depth, 1);
    assert.equal(only(d).triggerPayload.origin_run_id, only(a).id);
    assert.equal(only(d).triggerPayload.root_run_id, only(a).id);
  });
});

// ---------- Lineage and depth ----------

describe("lineage and depth", () => {
  it("every child has its own run key and the parent's lineage at one level deeper", async () => {
    const [b, c, d] = [quick("B"), quick("C"), quick("D")];
    const a = journey("A", "manual", [fan([b, c, d]), task("after")]);
    await enroll(a);
    const parent = only(a);
    for (const id of [b, c, d]) {
      const child = only(id);
      assert.equal(child.idempotencyKey, `journey.started:${parent.id}:${a}-n0:${id}`);
      assert.deepEqual(child.triggerPayload, {
        origin: "journey", origin_run_id: parent.id, origin_journey_id: a, root_run_id: parent.id, causation_depth: 1,
      });
      assert.equal(runCausationDepth(child), 2, "a fan-out is one level, not one per child");
    }
    assert.equal(fanOutput(parent).causation_depth, 1);
  });

  it("at the depth cap every child is skipped as depth_limited; the parent continues", async () => {
    const [b, c] = [quick("B"), quick("C")];
    const a = journey("A", "journey.started", [fan([b, c]), task("after")]);
    await dispatchJourneyEvent(deps, {
      tenantId: tenant, type: "journey.started", journeyId: a, sourceId: randomUUID(), contactId: contact, entityType: "contact", entityId: contact,
      payload: { origin: "journey", origin_run_id: randomUUID(), causation_depth: 2 },
    });
    const parent = only(a);
    assert.equal(runCausationDepth(parent), 3);
    assert.equal(parent.status, "completed");
    for (const id of [b, c]) {
      assert.equal(childOf(parent, id).skipped_reason, "depth_limited");
      assert.equal(runsOf(id).length, 0);
    }
  });

  it("A → B, C → D stays bounded: D runs at depth 3 and can't start anything further", async () => {
    const e = quick("E");
    const d = journey("D", "journey.started", [{ action: "start_journey", journeyId: e }, task("d")]);
    const b = journey("B", "journey.started", [{ action: "start_journey", journeyId: d, waitForCompletion: true }, task("b")]);
    const c = journey("C", "journey.started", [waitDay, { action: "start_journey", journeyId: d, waitForCompletion: true }, task("c")]);
    const a = journey("A", "manual", [fan([b, c]), task("after")]);
    await enroll(a);
    await worker(DAY);
    await worker();

    assert.equal(only(a).status, "completed");
    const dRuns = runsOf(d);
    assert.equal(dRuns.length, 2, "one D per starting step");
    for (const run of dRuns) assert.equal(runCausationDepth(run), 3);
    assert.equal(runsOf(e).length, 0, "depth 4 never starts");
    assert.equal(runs().length, 5);
  });
});
