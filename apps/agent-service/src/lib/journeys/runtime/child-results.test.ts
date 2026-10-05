/**
 * Child results: a journey declares the results it returns on its "Started by
 * another journey" trigger (results: [{ name, source }], sources are its own
 * step outputs); a waiting Start journey step receives only declared names it
 * maps (resultMappings: [{ target, source: "result.<name>" }]) as
 * output.results. Results are captured in the write that completes the child
 * and never resolved again. Real engine, dispatcher, worker entry, run retry,
 * and memory store.
 */

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { beforeEach, describe, it } from "node:test";
import type { JourneyAIExecutor, JourneyAIRequest } from "./ai.ts";
import { resolveField, type ExecutionContext } from "./conditions.ts";
import {
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
  RETRY_BACKOFF_MS,
  resumeDueRuns,
  runCausationDepth,
  type ActionExecutor,
  type EngineDeps,
} from "./engine.ts";
import { activationIssues, knownOutputFields, type JourneySnapshot, type SnapshotNode } from "./graph.ts";
import { MemoryJourneyStore, type MemoryRun } from "./memory-store.ts";
import { retryJourneyRun, type RunRetryLookups } from "./run-retry.ts";

let store: MemoryJourneyStore;
let deps: EngineDeps;
let tenant: string;
let contact: string;
let clock: number;
let names: Map<string, string>;
let performed: string[];
let failNextTask: Set<string>;
let failNextTaskTransient: Set<string>;
/** AI output by node id; a function gets the request (for per-contact outputs). */
let aiOutputs: Map<string, Record<string, unknown> | ((request: JourneyAIRequest) => Record<string, unknown>)>;
let aiCalls: number;

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
  aiCalls = 0;
  store.contacts.set(contact, { tenantId: tenant, lead: { lead_status: "New", budget: "500k" } });

  const ai: JourneyAIExecutor = {
    async execute(request) {
      aiCalls++;
      const configured = aiOutputs.get(request.nodeId);
      const output = typeof configured === "function" ? configured(request) : (configured ?? {});
      return { success: true, output: structuredClone(output), text: "PRIVATE child reasoning" };
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
const aiStep = (): Step => ({ type: "ai", goal: "Decide", instructions: "", agent: "default" });
const waitDay: Step = { action: "wait", duration: 1, unit: "days" };
const callWait = (journeyId: string, resultMappings?: ResultMapping[], inputMappings?: InputMapping[]): Step => ({
  action: "start_journey",
  journeyId,
  waitForCompletion: true,
  ...(resultMappings ? { resultMappings } : {}),
  ...(inputMappings ? { inputMappings } : {}),
});
const start = (journeyId: string): Step => ({ action: "start_journey", journeyId });
const receive = (target: string, name = target): ResultMapping => ({ target, source: `result.${name}` });
/** steps.<node-id key>.output.<field> of node <journey>-n<index>. */
const out = (journeyId: string, index: number, field: string) => `steps.${nodeReferenceKey(`${journeyId}-n${index}`)}.output.${field}`;
const declare = (name: string, journeyId: string, index: number, field = name): ResultExport => ({ name, source: out(journeyId, index, field) });

/** Trigger → steps in order. Node ids are `<journey id>-n<index>`; `results` is the trigger's declaration. */
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

/** Manual trigger → call-and-wait → Condition `field` equals `value` → task "yes" / task "no". */
function waitThenBranch(name: string, target: string, mappings: ResultMapping[], field: (id: string) => string, value: unknown) {
  const id = randomUUID();
  names.set(id, name);
  const node = (suffix: string, type: SnapshotNode["type"], config: Record<string, unknown>): SnapshotNode => ({ id: `${id}-${suffix}`, type, name: suffix, description: "", config });
  const link = (source: string, targetNode: string, sourceHandle: string | null = null) => ({ id: `${source}>${targetNode}`, sourceNodeId: `${id}-${source}`, targetNodeId: `${id}-${targetNode}`, sourceHandle, targetHandle: null });
  store.saveJourney(tenant, id, {
    nodes: [
      node("t", "trigger", { event: "manual", filters: [] }),
      node("n0", "action", callWait(target, mappings)),
      node("c", "condition", { field: field(id), operator: "equals", value }),
      node("y", "action", task("yes")),
      node("n", "action", task("no")),
    ],
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
const callOutput = (run: MemoryRun) => stepAt(run, 0).output as Record<string, unknown>;

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

async function worker(ms = 0) {
  clock += ms;
  return resumeDueRuns(deps);
}

/** B: AI step (n0) → task (n1); returns `exports` of the AI step's output. */
function decidingChild(output: Record<string, unknown>, exports: string[], extra: { id?: string } = {}) {
  const id = extra.id ?? randomUUID();
  aiOutputs.set(`${id}-n0`, output);
  return journey("B", "journey.started", [aiStep(), task("child")], { id, results: (b) => exports.map((name) => declare(name, b, 0)) });
}

const STAGE4_KEYS = ["causation_depth", "child_status", "run_id", "started", "target_journey_id"];

// ---------- Contract and validation ----------

describe("contract", () => {
  const trigger = (results: unknown, event = "journey.started") => validateNodeConfig("trigger", { event, filters: [], results }, "strict");
  const startStep = (config: Record<string, unknown>) =>
    validateNodeConfig("action", { action: "start_journey", journeyId: randomUUID(), ...config }, "strict");
  const ref = "steps.abc.output.decision";

  it("a journey.started trigger declares up to 10 named results whose sources are single step-output fields", () => {
    assert.deepEqual(trigger([{ name: "decision", source: ref }]).errors, []);
    assert.deepEqual(trigger([{ name: "decision", source: ref }]).config.results, [{ name: "decision", source: ref }]);
    assert.deepEqual(trigger([{ name: "relayed", source: "steps.abc.output.results.decision" }]).errors, [], "a received result can be passed on");
    assert.deepEqual(validateNodeConfig("trigger", { event: "journey.started", filters: [] }, "strict").config, { event: "journey.started", filters: [] });
  });

  it("rejects malformed lists, bad or repeated names, too many, and anything but a step-output field", () => {
    assert.deepEqual(trigger("nope").errors, ["Results: the result list is malformed."]);
    assert.deepEqual(trigger([{ name: "Decision", source: ref }]).errors, ['Result 1: use lowercase letters, numbers, and underscores, starting with a letter.']);
    assert.deepEqual(trigger([{ name: "a", source: ref }, { name: "a", source: ref }]).errors, ['Result "a" is used more than once.']);
    assert.ok(trigger(Array.from({ length: 11 }, (_, i) => ({ name: `r${i}`, source: ref }))).errors.includes("Return at most 10 results."));
    for (const source of ["lead.budget", "trigger.inputs.tier", "steps.abc.output", "context.steps", "run.id", "parent.x", "steps.abc.output.a.b", "trigger.origin_run_id", ""]) {
      assert.deepEqual(trigger([{ name: "x", source }]).errors, ['Result "x": choose the step output to return.'], source);
    }
    assert.deepEqual(trigger([{ name: "x", source: ref }], "manual").errors, ["Results: only a journey started by another journey can return results."]);
  });

  it("result mappings need waitForCompletion, valid unique targets, and result.<name> sources", () => {
    assert.deepEqual(startStep({ waitForCompletion: true, resultMappings: [receive("decision")] }).errors, []);
    assert.deepEqual(startStep({ resultMappings: [receive("decision")] }).errors, ["Results: only a step that waits for the journey to finish can receive results."]);
    assert.deepEqual(startStep({ waitForCompletion: true, resultMappings: {} }).errors, ["Results: the result list is malformed."]);
    assert.deepEqual(startStep({ waitForCompletion: true, resultMappings: [receive("a", "x"), receive("a", "y")] }).errors, ['Result "a" is used more than once.']);
    for (const source of ["decision", "result.", "result.Decision", "steps.abc.output.decision", "results.decision", "result.a.b"]) {
      assert.deepEqual(startStep({ waitForCompletion: true, resultMappings: [{ target: "a", source }] }).errors, ['Result "a": choose a result the started journey returns.'], source);
    }
    assert.ok(startStep({ waitForCompletion: true, resultMappings: Array.from({ length: 11 }, (_, i) => receive(`r${i}`)) }).errors.includes("Receive at most 10 results."));
    assert.deepEqual(Object.keys(startStep({ waitForCompletion: true }).config), ["action", "journeyId", "waitForCompletion"], "no mappings: Stage 4's config");
  });

  it("activation checks each declared source: an existing, output-producing, reachable step and a field it defines", () => {
    const id = randomUUID();
    const typed: Step = { type: "ai", goal: "Decide", instructions: "", agent: "default", outputSchema: [{ name: "decision", type: "string", description: "" }] };
    const graph = (results: ResultExport[]) => snapshotOf(id, "journey.started", [typed, waitDay, task()], results);
    const messages = (results: ResultExport[]) => activationIssues(graph(results)).map((issue) => issue.message);

    assert.deepEqual(messages([declare("decision", id, 0)]), []);
    assert.deepEqual(messages([declare("x", id, 0, "missing")]), ['"Trigger": Result "x": output field "missing" isn\'t defined by "Step 0".']);
    assert.deepEqual(messages([declare("x", id, 1, "anything")]), ['"Trigger": Result "x": "Step 1" isn\'t a step that produces output a result can return.']);
    assert.deepEqual(messages([{ name: "x", source: `steps.${nodeReferenceKey(`${id}-t`)}.output.event` }]), ['"Trigger": Result "x": "Trigger" isn\'t a step that produces output a result can return.']);
    assert.deepEqual(messages([{ name: "x", source: "steps.nowhere.output.decision" }]), ['"Trigger": Result "x": the referenced journey step no longer exists.']);

    const unreachable = graph([declare("x", id, 2, "anything")]);
    unreachable.connections = unreachable.connections.filter((connection) => connection.targetNodeId !== `${id}-n2`);
    assert.ok(activationIssues(unreachable).some((issue) => issue.message === '"Trigger": Result "x": "Step 2" isn\'t reachable from a trigger.'));
  });

  it("a condition can read results.<name> only of a waiting step that receives that name", () => {
    const target = randomUUID();
    const p = randomUUID();
    const condition = (field: string, call: Step): JourneySnapshot => {
      const snapshot = snapshotOf(p, "manual", [call, { type: "condition" as never, field, operator: "equals", value: "approved" } as Step, task()]);
      snapshot.nodes[2].type = "condition";
      snapshot.connections[2].sourceHandle = "yes";
      return snapshot;
    };
    const messages = (snapshot: JourneySnapshot) => activationIssues(snapshot).map((issue) => issue.message);

    assert.deepEqual(messages(condition(out(p, 0, "results.decision"), callWait(target, [receive("decision")]))), []);
    assert.deepEqual(messages(condition(out(p, 0, "child_status"), callWait(target, [receive("decision")]))), []);
    assert.deepEqual(messages(condition(out(p, 0, "results.other"), callWait(target, [receive("decision")]))), [
      '"Step 1": "Step 0" doesn\'t receive a result named "other".',
    ]);
    assert.deepEqual(messages(condition(out(p, 0, "results.decision"), callWait(target))), ['"Step 1": "Step 0" doesn\'t receive a result named "decision".']);
    assert.deepEqual(knownOutputFields({ type: "action", config: callWait(target) }), null, "Stage 4 steps stay free-form");
  });

  it("resolveField reads results.<name>: own keys of a plain object only", () => {
    const context = (output: Record<string, unknown>): ExecutionContext => ({ lead: null, opportunity: null, trigger: { event: "manual", payload: {} }, steps: { call: { output } } });
    assert.equal(resolveField(context({ results: { decision: "approved" } }), "steps.call.output.results.decision"), "approved");
    assert.equal(resolveField(context({ results: { decision: "approved" } }), "steps.call.output.results.constructor"), undefined);
    assert.equal(resolveField(context({ results: ["approved"] }), "steps.call.output.results.decision"), undefined);
    assert.equal(resolveField(context({ results: "approved" }), "steps.call.output.results.decision"), undefined);
    assert.equal(resolveField(context({ decision: "approved" }), "steps.call.output.results.decision"), undefined);
  });
});

// ---------- Results ----------

describe("results", () => {
  it("basic: the child declares one result and completes; the parent receives exactly that value", async () => {
    const b = decidingChild({ decision: "approved" }, ["decision"]);
    const a = journey("A", "manual", [callWait(b, [receive("decision")]), task("after")]);

    await enroll(a);

    assert.equal(only(a).status, "completed");
    assert.deepEqual(callOutput(only(a)), {
      started: true, target_journey_id: b, run_id: only(b).id, causation_depth: 1, child_status: "completed", results: { decision: "approved" },
    });
    assert.deepEqual(only(b).context.results, { decision: "approved" }, "captured on the child run");
    assert.deepEqual(performed, ["B:child", "A:after"]);
  });

  it("multiple scalar results, renamed on the parent side", async () => {
    const b = decidingChild({ decision: "approved", score: 0.92, qualified: true, note: null }, ["decision", "score", "qualified", "note"]);
    const a = journey("A", "manual", [callWait(b, [receive("verdict", "decision"), receive("score"), receive("qualified"), receive("note")])]);

    await enroll(a);

    assert.deepEqual(callOutput(only(a)).results, { verdict: "approved", score: 0.92, qualified: true, note: null });
  });

  it("explicit export: only declared values can be received; an undeclared one is an error, not a value", async () => {
    const b = decidingChild({ decision: "approved", secret: "TOP-SECRET" }, ["decision"]);
    const a = journey("A", "manual", [callWait(b, [receive("decision"), receive("secret")]), task("after")]);

    await enroll(a);

    const output = callOutput(only(a));
    assert.deepEqual(output.results, {}, "all or nothing");
    assert.equal(output.results_error, "results_not_exported");
    assert.deepEqual(output.result_errors, ['Result "secret": the started journey doesn\'t return "secret".']);
    assert.equal(only(a).status, "completed", "not a parent failure");
    const parentData = JSON.stringify([only(a), store.stepsFor(only(a).id)]);
    for (const leaked of ["TOP-SECRET", "PRIVATE child reasoning"]) assert.ok(!parentData.includes(leaked), leaked);
  });

  it("no declaration: without mappings the output is exactly Stage 4's; with mappings nothing is returned", async () => {
    const b = decidingChild({ decision: "approved" }, []);
    const plain = journey("A", "manual", [callWait(b)]);
    await enroll(plain);
    assert.deepEqual(Object.keys(callOutput(only(plain))).sort(), STAGE4_KEYS);
    assert.equal(only(b).context.results, undefined, "nothing captured");

    const c = decidingChild({ decision: "approved" }, []);
    const mapped = journey("M", "manual", [callWait(c, [receive("decision")])]);
    await enroll(mapped);
    assert.deepEqual(callOutput(only(mapped)).results, {});
    assert.equal(callOutput(only(mapped)).results_error, "results_not_exported");
  });

  it("a declared source whose value is missing (or whose step didn't run) returns null", async () => {
    const b = journey("B", "journey.started", [aiStep(), task("child")], {
      results: (id) => [declare("decision", id, 0), declare("absent", id, 0, "never_set")],
    });
    aiOutputs.set(`${b}-n0`, { decision: "approved" });
    const a = journey("A", "manual", [callWait(b, [receive("decision"), receive("absent")])]);

    await enroll(a);

    assert.deepEqual(callOutput(only(a)).results, { decision: "approved", absent: null });
    assert.equal(callOutput(only(a)).results_error, undefined);
  });

  for (const [label, value, reason] of [
    ["an object", { nested: true }, "results_invalid"],
    ["an array", ["a", "b"], "results_invalid"],
    ["a non-finite number", Number.POSITIVE_INFINITY, "results_invalid"],
    ["an oversized value", "x".repeat(9000), "results_too_large"],
  ] as const) {
    it(`${label} isn't returned or stringified: the child completes, records why, and the parent gets no results at all`, async () => {
      const b = decidingChild({ ok: "fine", bad: value }, ["ok", "bad"]);
      const a = journey("A", "manual", [callWait(b, [receive("ok"), receive("bad")]), task("after")]);

      await enroll(a);

      assert.equal(only(b).status, "completed");
      assert.equal(only(b).context.results, undefined);
      assert.equal(only(b).context.resultsError?.reason, reason);
      const output = callOutput(only(a));
      assert.deepEqual(output.results, {});
      assert.equal(output.results_error, reason);
      assert.equal(only(a).status, "completed");
      assert.ok(!JSON.stringify(output).includes("fine"), "no partial result");
    });
  }

  it("results can't overwrite the step's own fields: they're nested under results", async () => {
    const b = decidingChild({ run_id: "forged-run", child_status: "completed", causation_depth: 0 }, ["run_id", "child_status", "causation_depth"]);
    const a = journey("A", "manual", [callWait(b, [receive("run_id"), receive("child_status"), receive("causation_depth")])]);

    await enroll(a);

    const output = callOutput(only(a));
    assert.equal(output.run_id, only(b).id);
    assert.equal(output.causation_depth, 1);
    assert.deepEqual(output.results, { run_id: "forged-run", child_status: "completed", causation_depth: 0 });
  });
});

// ---------- Failure, cancellation, retry ----------

describe("child outcome", () => {
  it("a failed child returns no results, even ones it computed; the parent branches on child_status", async () => {
    const b = decidingChild({ decision: "approved" }, ["decision"]);
    failNextTask.add("B");
    const a = waitThenBranch("A", b, [receive("decision")], (id) => out(id, 0, "child_status"), "completed");

    await enroll(a);

    assert.equal(only(b).status, "failed");
    assert.equal(only(b).context.results, undefined);
    const output = callOutput(only(a));
    assert.equal(output.child_status, "failed");
    assert.deepEqual(output.results, {});
    assert.equal(output.results_error, undefined);
    assert.deepEqual(performed, ["A:no"]);
  });

  it("a cancelled child returns no results", async () => {
    const id = randomUUID();
    aiOutputs.set(`${id}-n0`, { decision: "approved" });
    const b = journey("B", "journey.started", [aiStep(), waitDay, task("child")], { id, results: (child) => [declare("decision", child, 0)] });
    const a = journey("A", "manual", [callWait(b, [receive("decision")]), task("after")]);
    await enroll(a);
    store.setStatus(b, "archived");

    await worker(24 * 60 * 60_000);
    await worker();

    assert.equal(only(b).status, "cancelled");
    assert.equal(only(a).status, "completed");
    const output = store.stepsFor(only(a).id).find((step) => step.nodeId === `${a}-n0`)!.output!;
    assert.equal(output.child_status, "cancelled");
    assert.deepEqual(output.results, {});
    assert.ok(!JSON.stringify([only(a), store.stepsFor(only(a).id)]).includes("approved"));
  });

  it("a transiently failing child: the parent waits, nothing is captured until the child completes, then once", async () => {
    const b = decidingChild({ decision: "approved" }, ["decision"]);
    failNextTaskTransient.add("B");
    const a = journey("A", "manual", [callWait(b, [receive("decision")]), task("after")]);

    await enroll(a);
    assert.equal(only(b).status, "waiting");
    assert.equal(only(b).context.results, undefined);
    assert.equal(only(a).status, "waiting");
    assert.equal(callOutput(only(a)).results, undefined);

    await worker(RETRY_BACKOFF_MS[0]);
    assert.deepEqual(only(b).context.results, { decision: "approved" });
    await worker();
    assert.deepEqual(callOutput(only(a)).results, { decision: "approved" });
    assert.equal(aiCalls, 1, "the AI step wasn't repeated");
  });

  it("results are a snapshot of the child's step outputs at completion: later lead changes don't alter them", async () => {
    const b = journey("B", "journey.started", [aiStep(), waitDay, task("child")], { results: (id) => [declare("budget_seen", id, 0)] });
    aiOutputs.set(`${b}-n0`, (request) => ({ budget_seen: request.context.lead?.budget ?? null }));
    const a = journey("A", "manual", [callWait(b, [receive("budget_seen")]), task("after")]);
    await enroll(a);
    store.contacts.get(contact)!.lead.budget = "CHANGED";

    await worker(24 * 60 * 60_000);
    await worker();

    assert.deepEqual(callOutput(only(a)).results, { budget_seen: "500k" });
  });
});

// ---------- Parent retry, crash, concurrency, idempotency ----------

describe("parent retry and recovery", () => {
  it("a parent retried at the call step after the child completed reuses the captured results: no new child, no re-resolution", async () => {
    const b = journey("B", "journey.started", [aiStep(), task("child")], { results: (id) => [declare("decision", id, 0)] });
    aiOutputs.set(`${b}-n0`, { decision: "approved" });
    const a = journey("A", "manual", [callWait(b, [receive("decision")]), task("after")]);
    await enroll(a);
    const live = store.runs.get(only(a).id)!;
    const step = stepAt(live, 0);
    store.steps = store.steps.filter((entry) => entry.runId !== live.id || entry.id === step.id);
    Object.assign(step, { status: "failed", output: {}, error: "Journey store updateRun failed: timeout", errorKind: "transient" });
    Object.assign(live, { status: "failed", currentNodeId: `${a}-n0`, context: { steps: {}, attempts: {} } });
    aiOutputs.set(`${b}-n0`, { decision: "REJECTED-NOW" });
    store.contacts.get(contact)!.lead.budget = "CHANGED";
    performed = [];

    assert.equal((await retry(live)).result, "retried");
    await worker();

    assert.equal(runsOf(b).length, 1);
    assert.equal(aiCalls, 1);
    assert.deepEqual(callOutput(only(a)).results, { decision: "approved" });
    assert.equal(callOutput(only(a)).duplicate, true);
    assert.deepEqual(performed, ["A:after"]);
  });

  it("a completed child can't be retried, so its captured results can't be rewritten", async () => {
    const b = decidingChild({ decision: "approved" }, ["decision"]);
    const a = journey("A", "manual", [callWait(b, [receive("decision")])]);
    await enroll(a);
    assert.deepEqual(await retry(only(b)), { result: "blocked", reason: "not_failed", journeyId: b });
    assert.deepEqual(only(b).context.results, { decision: "approved" });
  });

  it("crash: the child completed but its wake-up was lost; the parent's recheck later delivers the same snapshot", async () => {
    const id = randomUUID();
    aiOutputs.set(`${id}-n0`, { decision: "approved" });
    const b = journey("B", "journey.started", [aiStep(), waitDay, task("child")], { id, results: (child) => [declare("decision", child, 0)] });
    const a = journey("A", "manual", [callWait(b, [receive("decision")]), task("after")]);
    await enroll(a);
    const wake = store.wakeWaitingParent;
    store.wakeWaitingParent = async () => {
      throw new Error("process died");
    };
    await worker(24 * 60 * 60_000);
    store.wakeWaitingParent = wake;
    assert.equal(only(b).status, "completed");
    assert.equal(only(a).status, "waiting");
    aiOutputs.set(`${b}-n0`, { decision: "REJECTED-NOW" });

    await worker(CHILD_WAIT_RECHECK_MS);

    assert.equal(only(a).status, "completed");
    assert.deepEqual(callOutput(only(a)).results, { decision: "approved" });
    assert.deepEqual(performed, ["B:child", "A:after"]);
  });

  it("crash before the parent parked: the repeated step finds the same child and its captured results", async () => {
    const b = decidingChild({ decision: "approved" }, ["decision"]);
    const a = journey("A", "manual", [callWait(b, [receive("decision")]), task("after")]);
    await enroll(a);
    const live = store.runs.get(only(a).id)!;
    const step = stepAt(live, 0);
    Object.assign(step, { status: "running", output: { started: true, target_journey_id: b, run_id: only(b).id, causation_depth: 1, waiting: true } });
    store.steps = store.steps.filter((entry) => entry.runId !== live.id || entry.id === step.id);
    Object.assign(live, {
      status: "running", currentNodeId: `${a}-n0`, lockedUntil: null, completedAt: null, resumeAt: new Date(clock).toISOString(),
      context: { steps: {}, attempts: {}, inFlight: { nodeId: `${a}-n0`, stepId: step.id } },
    });
    performed = [];

    await worker();

    assert.equal(runsOf(b).length, 1);
    assert.equal(only(a).status, "completed");
    assert.deepEqual(callOutput(only(a)).results, { decision: "approved" });
    assert.deepEqual(performed, ["A:after"]);
  });

  it("concurrent resumes: one continuation, results intact", async () => {
    const id = randomUUID();
    aiOutputs.set(`${id}-n0`, { decision: "approved", score: 7 });
    const b = journey("B", "journey.started", [aiStep(), waitDay, task("child")], { id, results: (child) => [declare("decision", child, 0), declare("score", child, 0)] });
    const a = journey("A", "manual", [callWait(b, [receive("decision"), receive("score")]), task("after")]);
    await enroll(a);
    await worker(24 * 60 * 60_000);

    const outcomes = await Promise.all([executeRun(deps, only(a).id), executeRun(deps, only(a).id)]);

    assert.deepEqual(outcomes.map((outcome) => outcome.status).sort(), ["completed", "not_claimed"]);
    assert.deepEqual(callOutput(only(a)).results, { decision: "approved", score: 7 });
    assert.equal(stepsAt(only(a), 1).length, 1);
    assert.deepEqual(performed, ["B:child", "A:after"]);
  });

  it("idempotency: the run key is unchanged, redelivery creates no second child, and a re-saved child keeps its run's version", async () => {
    const id = randomUUID();
    aiOutputs.set(`${id}-n0`, { decision: "approved" });
    const b = journey("B", "journey.started", [aiStep(), waitDay, task("child")], { id, results: (child) => [declare("decision", child, 0)] });
    const a = journey("A", "manual", [callWait(b, [receive("decision")])]);
    await enroll(a);
    assert.equal(only(b).idempotencyKey, `journey.started:${only(a).id}:${a}-n0:${b}`);

    const redelivered = await dispatchJourneyEvent(deps, {
      tenantId: tenant, type: "journey.started", journeyId: b, sourceId: `${only(a).id}:${a}-n0`, contactId: contact, entityType: "contact", entityId: contact,
      payload: { origin: "journey", origin_run_id: only(a).id, causation_depth: 1, results: { decision: "FORGED" } },
    });
    assert.notEqual(redelivered[0]?.result, "started");
    assert.equal(runsOf(b).length, 1);

    // v2 no longer declares "decision"; the running child is pinned to v1.
    store.saveJourney(tenant, b, snapshotOf(b, "journey.started", [aiStep(), waitDay, task("child")], [declare("renamed", b, 0, "decision")]));
    await worker(24 * 60 * 60_000);
    await worker();

    assert.deepEqual(callOutput(only(a)).results, { decision: "approved" });
  });
});

// ---------- Security ----------

describe("security", () => {
  it("forged results in the child's trigger payload or in a step output named results are ignored", async () => {
    const id = randomUUID();
    aiOutputs.set(`${id}-n0`, { decision: "approved", results: { decision: "FORGED-OUTPUT" } });
    const b = journey("B", "journey.started", [aiStep(), waitDay, task("child")], { id, results: (child) => [declare("decision", child, 0)] });
    const a = journey("A", "manual", [callWait(b, [receive("decision")])]);
    await enroll(a);
    store.runs.get(only(b).id)!.triggerPayload.results = { decision: "FORGED-PAYLOAD" };

    await worker(24 * 60 * 60_000);
    await worker();

    assert.deepEqual(callOutput(only(a)).results, { decision: "approved" });
    assert.ok(!JSON.stringify([only(a), store.stepsFor(only(a).id)]).includes("FORGED"));
  });

  it("stored child results are untrusted: a tampered non-scalar is rejected, not passed on", async () => {
    const id = randomUUID();
    aiOutputs.set(`${id}-n0`, { decision: "approved" });
    const b = journey("B", "journey.started", [aiStep(), waitDay, task("child")], { id, results: (child) => [declare("decision", child, 0)] });
    const a = journey("A", "manual", [callWait(b, [receive("decision")])]);
    await enroll(a);
    await worker(24 * 60 * 60_000);
    store.runs.get(only(b).id)!.context.results = { decision: { injected: true } } as never;

    await worker();

    assert.deepEqual(callOutput(only(a)).results, {});
    assert.equal(callOutput(only(a)).results_error, "results_invalid");
  });

  it("each parent receives only its own child's results (another contact's run, same journeys)", async () => {
    const second = randomUUID();
    store.contacts.set(second, { tenantId: tenant, lead: { lead_status: "New" } });
    const b = journey("B", "journey.started", [aiStep(), task("child")], { results: (id) => [declare("who", id, 0)] });
    aiOutputs.set(`${b}-n0`, (request) => ({ who: request.contactId }));
    const a = journey("A", "manual", [callWait(b, [receive("who")])]);

    await enroll(a);
    await enroll(a, second);

    for (const parent of runsOf(a)) assert.deepEqual(callOutput(parent).results, { who: parent.contactId });
  });

  it("the parent sees no child context: not its steps, AI text, trigger payload, inputs, or undeclared outputs", async () => {
    const b = decidingChild({ decision: "approved", internal_score: 42 }, ["decision"]);
    const a = journey("A", "manual", [callWait(b, [receive("decision")], [{ target: "budget", source: "lead.budget" }])]);

    await enroll(a);

    const parent = only(a);
    assert.deepEqual(Object.keys(callOutput(parent)).sort(), [...STAGE4_KEYS, "results"].sort());
    const parentData = JSON.stringify([parent, store.stepsFor(parent.id)]);
    for (const leaked of ["internal_score", "PRIVATE child reasoning", "origin_journey_id", "root_run_id"]) assert.ok(!parentData.includes(leaked), leaked);
    assert.equal(parent.context.results, undefined, "results live on the call step's output only");
  });

  it("results never cross workspaces: a target in another workspace isn't started or read", async () => {
    const foreign = decidingChild({ decision: "approved" }, ["decision"]);
    store.journeys.get(foreign)!.tenantId = randomUUID();
    const a = journey("A", "manual", [callWait(foreign, [receive("decision")]), task("after")]);

    await enroll(a);

    assert.equal(callOutput(only(a)).skipped_reason, "target_not_found");
    assert.equal(callOutput(only(a)).results, undefined);
  });
});

// ---------- Conditions ----------

describe("conditions", () => {
  for (const [decision, branch] of [["approved", "yes"], ["denied", "no"]] as const) {
    it(`a condition on results.decision takes the ${branch} path when the child returns "${decision}"`, async () => {
      const b = decidingChild({ decision }, ["decision"]);
      const a = waitThenBranch("A", b, [receive("decision")], (id) => out(id, 0, "results.decision"), "approved");
      await enroll(a);
      assert.deepEqual(performed, ["B:child", `A:${branch}`]);
    });
  }

  it("a missing result reads as empty", async () => {
    const b = decidingChild({}, ["decision"]);
    const a = waitThenBranch("A", b, [receive("decision")], (id) => out(id, 0, "results.decision"), "approved");
    await enroll(a);
    assert.deepEqual(performed, ["B:child", "A:no"]);
    assert.deepEqual(callOutput(only(a)).results, { decision: null });
  });
});

// ---------- Lineage and causation ----------

describe("lineage and causation", () => {
  it("the child's lineage and Stage 3 inputs are unchanged; results don't touch the parent's lineage or depth", async () => {
    const b = decidingChild({ origin_run_id: "forged", causation_depth: 0, root_run_id: "forged" }, ["origin_run_id", "causation_depth", "root_run_id"]);
    const c = journey("C", "journey.started", [task("c")]);
    const a = journey("A", "manual", [callWait(b, [receive("origin_run_id"), receive("causation_depth"), receive("root_run_id")], [{ target: "budget", source: "lead.budget" }]), start(c)]);

    await enroll(a);

    const [parent, child, next] = [only(a), only(b), only(c)];
    assert.deepEqual(child.triggerPayload, {
      origin: "journey", origin_run_id: parent.id, origin_journey_id: a, root_run_id: parent.id, causation_depth: 1, inputs: { budget: "500k" },
    });
    assert.deepEqual(parent.triggerPayload, { enrolled_by: "user" });
    assert.equal(runCausationDepth(parent), 1);
    assert.deepEqual(next.triggerPayload, { origin: "journey", origin_run_id: parent.id, origin_journey_id: a, root_run_id: parent.id, causation_depth: 1 });
  });

  it("results can be passed up a chain (C → B → A) and the depth cap still holds", async () => {
    const d = journey("D", "journey.started", [task("d")]);
    const c = decidingChild({ verdict: "deep" }, ["verdict"]);
    names.set(c, "C");
    const cNodes = store.journeys.get(c)!;
    const cSnapshot = cNodes.versions.get(cNodes.version)!;
    cSnapshot.nodes.push({ id: `${c}-n2`, type: "action", name: "Step 2", description: "", config: callWait(d) });
    cSnapshot.connections.push({ id: `${c}-c2`, sourceNodeId: `${c}-n1`, targetNodeId: `${c}-n2`, sourceHandle: null, targetHandle: null });
    const b = journey("B", "journey.started", [callWait(c, [receive("verdict")])], { results: (id) => [declare("relayed", id, 0, "results.verdict")] });
    const a = journey("A", "manual", [callWait(b, [receive("relayed")])]);

    await enroll(a);

    assert.equal(runsOf(d).length, 0, "C is at depth 3: its own Start journey is blocked");
    assert.equal(stepAt(only(c), 2).output?.skipped_reason, "depth_limited");
    assert.deepEqual(callOutput(only(b)).results, { verdict: "deep" });
    assert.deepEqual(callOutput(only(a)).results, { relayed: "deep" });
  });
});
