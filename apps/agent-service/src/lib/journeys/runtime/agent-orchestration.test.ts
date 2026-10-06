/**
 * Agent-requested journey starts: an AI step whose designer allowed it may ask
 * the engine to start one journey from the step's own list. The model sees
 * opaque keys only; the engine checks the request and starts the child through
 * the same path as a Start journey step (run key, lineage, depth guard, target
 * checks, one active run per lead), recording the outcome under
 * output.orchestration. Real engine, dispatcher, worker entry, run retry, and
 * memory store; the model is a scripted executor.
 */

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { beforeEach, describe, it } from "node:test";
import { allowedAgentJourneys, parseAgentJourneyRequest } from "./agent-orchestration.ts";
import {
  buildJourneyAIPrompt,
  createJourneyAIExecutor,
  JOURNEY_REQUEST_KEY,
  type JourneyAIExecutor,
  type JourneyAIRequest,
} from "./ai.ts";
import { resolveField, type ExecutionContext } from "./conditions.ts";
import {
  AI_ORCHESTRATION_KEY,
  MAX_AGENT_JOURNEY_TARGETS,
  MAX_INPUTS_BYTES,
  nodeReferenceKey,
  validateNodeConfig,
  type ResultExport,
} from "./contracts.ts";
import {
  dispatchJourneyEvent,
  executeRun,
  MAX_ATTEMPTS,
  RETRY_BACKOFF_MS,
  resumeDueRuns,
  runCausationDepth,
  runRootId,
  type ActionExecutor,
  type EngineDeps,
} from "./engine.ts";
import { activationIssues, knownOutputFields, type JourneySnapshot, type SnapshotNode } from "./graph.ts";
import { MemoryJourneyStore, type MemoryRun } from "./memory-store.ts";
import { retryJourneyRun, type RunRetryLookups } from "./run-retry.ts";

const DAY = 24 * 60 * 60_000;

/** What the scripted model answers on one call. `request` is returned as start_journey. */
type Answer = { output?: Record<string, unknown>; request?: unknown; fail?: "transient" | "config" };

let store: MemoryJourneyStore;
let deps: EngineDeps;
let tenant: string;
let contact: string;
let clock: number;
let names: Map<string, string>;
let performed: string[];
let answers: Map<string, (request: JourneyAIRequest, call: number) => Answer>;
let aiRequests: JourneyAIRequest[];
/** Return the scripted request even when the engine offered no journeys (a misbehaving executor). */
let forceRequest: boolean;

beforeEach(() => {
  store = new MemoryJourneyStore();
  clock = Date.now();
  store.clock = () => new Date(clock);
  tenant = randomUUID();
  contact = randomUUID();
  names = new Map();
  performed = [];
  answers = new Map();
  aiRequests = [];
  forceRequest = false;
  store.contacts.set(contact, { tenantId: tenant, lead: { lead_status: "New", budget: "500k" } });

  const ai: JourneyAIExecutor = {
    async execute(request) {
      aiRequests.push(structuredClone(request));
      const call = aiRequests.filter((entry) => entry.runId === request.runId && entry.nodeId === request.nodeId).length;
      const answer = answers.get(request.nodeId)?.(request, call) ?? {};
      if (answer.fail) return { success: false, retryable: answer.fail === "transient", error: "AI busy." };
      const offered = (request.journeyOptions ?? []).length > 0;
      return {
        success: true,
        output: structuredClone(answer.output ?? { decided: true }),
        text: "PRIVATE model reasoning",
        ...(answer.request !== undefined && (offered || forceRequest) ? { journeyRequest: answer.request } : {}),
      };
    },
  };
  const actions: ActionExecutor = {
    async execute(action, input) {
      performed.push(`${names.get(input.nodeId.slice(0, 36)) ?? "?"}:${action.action === "create_task" ? action.title : action.action}`);
      return { status: "completed", output: {} };
    },
  };
  deps = { store, actions, ai, now: () => new Date(clock) };
});

type Step = Record<string, unknown> & { type?: "action" | "ai" | "condition" };
const task = (title: string): Step => ({ action: "create_task", title, notes: "", dueInDays: 1 });
const waitDay: Step = { action: "wait", duration: 1, unit: "days" };
const target = (journeyId: string, inputs?: string[], description = "When the lead fits") => ({
  journeyId,
  description,
  ...(inputs ? { inputs: inputs.map((name) => ({ name, description: `the ${name}` })) } : {}),
});
type Target = ReturnType<typeof target>;
const decider = (targets: Target[] | null): Step => ({
  type: "ai",
  goal: "Decide what happens next",
  instructions: "",
  agent: "default",
  ...(targets ? { allowJourneyOrchestration: true, orchestrationJourneys: targets } : {}),
});
const ask = (journey: string, inputs?: unknown) => ({ journey, ...(inputs !== undefined ? { inputs } : {}) });
const out = (journeyId: string, index: number, field: string) => `steps.${nodeReferenceKey(`${journeyId}-n${index}`)}.output.${field}`;

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

/** A journey whose first step (n0) is an AI step that may ask for `targets` (null: not allowed), answering `answer`. */
function asking(
  name: string,
  targets: Target[] | null,
  answer: Answer | ((request: JourneyAIRequest, call: number) => Answer),
  { event = "manual", tenantId = tenant, id = randomUUID(), then = [task(name.toLowerCase())] }: { event?: string; tenantId?: string; id?: string; then?: Step[] } = {},
) {
  answers.set(`${id}-n0`, typeof answer === "function" ? answer : () => answer);
  return journey(name, event, [decider(targets), ...then], { id, tenantId });
}

const quick = (name: string) => journey(name, "journey.started", [task(name.toLowerCase())]);
const slow = (name: string) => journey(name, "journey.started", [waitDay, task(name.toLowerCase())]);

async function enroll(journeyId: string, { contactId = contact, sourceId = randomUUID(), execute = true } = {}) {
  return dispatchJourneyEvent(
    deps,
    { tenantId: tenant, type: "manual", journeyId, sourceId, contactId, entityType: "contact", entityId: contactId, payload: { enrolled_by: "user" } },
    { execute },
  );
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
const orchestration = (run: MemoryRun) => (stepAt(run, 0).output as Record<string, unknown>)[AI_ORCHESTRATION_KEY] as Record<string, unknown> | undefined;
const offeredTo = (run: MemoryRun) => aiRequests.filter((request) => request.runId === run.id).at(-1)?.journeyOptions;

async function worker(ms = 0) {
  clock += ms;
  return resumeDueRuns(deps);
}

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

// ---------- Basic ----------

describe("an AI step asks for one journey", () => {
  it("the engine starts the allowed target through journey.started, with engine-derived lineage, and records the outcome", async () => {
    const b = quick("B");
    const a = asking("A", [target(b, ["area", "score"])], { request: ask("journey_1", { area: "Austin", score: 82 }) });
    await enroll(a);

    const parent = only(a);
    const child = only(b);
    assert.equal(parent.status, "completed", "the AI step continues; it never waits");
    assert.equal(child.status, "completed");
    assert.equal(child.triggerEvent, "journey.started");
    assert.equal(child.contactId, contact);
    assert.equal(child.idempotencyKey, `journey.started:${parent.id}:${a}-n0:${b}`);
    assert.deepEqual(child.triggerPayload, {
      origin: "journey",
      origin_run_id: parent.id,
      origin_journey_id: a,
      root_run_id: parent.id,
      causation_depth: 1,
      requested_by: "ai_step",
      inputs: { area: "Austin", score: 82 },
    });
    assert.deepEqual(orchestration(parent), {
      requested: true,
      action: "start_journey",
      journey: "journey_1",
      target_journey_id: b,
      started: true,
      run_id: child.id,
      causation_depth: 1,
    });
    assert.deepEqual(performed, ["A:a", "B:b"]);
    assert.equal(stepAt(parent, 0).output.decided, true, "the AI's own fields are kept beside orchestration");
  });

  it("the model is offered opaque keys, descriptions, and input names only: never a journey id", async () => {
    const [b, c] = [quick("B"), quick("C")];
    const a = asking("A", [target(b, ["area"], "Ready to book"), target(c, undefined, "Wants a valuation")], {});
    await enroll(a);
    const offered = offeredTo(only(a));
    assert.deepEqual(offered, [
      { key: "journey_1", description: "Ready to book", inputs: [{ name: "area", description: "the area" }] },
      { key: "journey_2", description: "Wants a valuation", inputs: [] },
    ]);
    assert.ok(!JSON.stringify(offered).includes(b) && !JSON.stringify(offered).includes(c));
    const prompt = buildJourneyAIPrompt(aiRequests[0], [], new Date(clock));
    assert.ok(prompt.system.includes('"key":"journey_1"') && prompt.system.includes("Ready to book"));
    assert.ok(!prompt.system.includes(b) && !prompt.user.includes(b) && !prompt.system.includes(c));
  });

  it("no request: output.orchestration says so, nothing starts, the journey continues", async () => {
    const b = quick("B");
    const a = asking("A", [target(b)], {});
    await enroll(a);
    assert.deepEqual(orchestration(only(a)), { requested: false, started: false });
    assert.equal(runsOf(b).length, 0);
    assert.equal(only(a).status, "completed");
  });

  it("a later condition branches on orchestration.started and orchestration.reason", async () => {
    const b = quick("B");
    const branchOn = (field: string, value: unknown, answer: Answer) => {
      const id = randomUUID();
      names.set(id, "P");
      answers.set(`${id}-n0`, () => answer);
      const node = (suffix: string, type: SnapshotNode["type"], config: Record<string, unknown>): SnapshotNode => ({ id: `${id}-${suffix}`, type, name: suffix, description: "", config });
      const link = (source: string, target: string, sourceHandle: string | null = null) => ({ id: `${source}>${target}`, sourceNodeId: `${id}-${source}`, targetNodeId: `${id}-${target}`, sourceHandle, targetHandle: null });
      store.saveJourney(tenant, id, {
        nodes: [
          node("t", "trigger", { event: "manual", filters: [] }),
          node("n0", "ai", decider([target(b)]) as Record<string, unknown>),
          node("c", "condition", { field: out(id, 0, `orchestration.${field}`), operator: "equals", value }),
          node("y", "action", task("yes")),
          node("n", "action", task("no")),
        ],
        connections: [link("t", "n0"), link("n0", "c"), link("c", "y", "yes"), link("c", "n", "no")],
      });
      return id;
    };
    const started = branchOn("started", true, { request: ask("journey_1") });
    await enroll(started);
    assert.ok(performed.includes("P:yes"));

    performed = [];
    const refused = branchOn("reason", "target_not_allowed", { request: ask("journey_7") });
    await enroll(refused, { contactId: contact });
    assert.ok(performed.includes("P:yes"), "the refusal reason is readable");
  });
});

// ---------- Authorization ----------

describe("authorization: only what the designer allowed, only what the engine accepts", () => {
  it("orchestration not allowed: no journeys offered; a request from a misbehaving executor is refused", async () => {
    const b = quick("B");
    forceRequest = true;
    const a = asking("A", null, { request: ask("journey_1") });
    await enroll(a);
    assert.equal(offeredTo(only(a)), undefined);
    assert.deepEqual(orchestration(only(a)), { requested: true, started: false, reason: "orchestration_disabled" });
    assert.equal(runsOf(b).length, 0);
  });

  it("orchestration not allowed and no request: the AI step's output is unchanged (no orchestration key)", async () => {
    const a = asking("A", null, { output: { score: 3 } });
    await enroll(a);
    assert.deepEqual(stepAt(only(a), 0).output, { score: 3, ai_response: "PRIVATE model reasoning" });
  });

  for (const [label, prepare, reason] of [
    ["paused", (id: string) => store.setStatus(id, "paused"), "target_inactive"],
    ["archived", (id: string) => store.setStatus(id, "archived"), "target_inactive"],
    ["draft", (id: string) => store.setStatus(id, "draft"), "target_inactive"],
  ] as const) {
    it(`a ${label} target isn't offered, and asking for it anyway starts nothing (${reason})`, async () => {
      const [b, c] = [quick("B"), quick("C")];
      prepare(b);
      const a = asking("A", [target(b), target(c)], { request: ask("journey_1") });
      await enroll(a);
      assert.deepEqual(offeredTo(only(a))?.map((option) => option.key), ["journey_2"]);
      assert.equal(orchestration(only(a))?.started, false);
      assert.equal(orchestration(only(a))?.reason, reason);
      assert.equal(runsOf(b).length, 0);
    });
  }

  it("a missing target and another workspace's journey look the same: not offered, target_not_found, nothing leaks", async () => {
    const missing = randomUUID();
    const foreign = journey("Foreign", "journey.started", [task("foreign")], { tenantId: randomUUID() });
    const decoy = quick("Decoy");
    const a = asking("A", [target(missing), target(foreign), target(decoy)], { request: ask("journey_1") });
    await enroll(a);
    assert.deepEqual(offeredTo(only(a))?.map((option) => option.key), ["journey_3"]);
    const first = orchestration(only(a));

    const a2 = asking("A2", [target(missing), target(foreign), target(decoy)], { request: ask("journey_2") });
    await enroll(a2);
    const second = orchestration(only(a2));
    assert.equal(first?.reason, "target_not_found");
    assert.equal(second?.reason, "target_not_found");
    assert.deepEqual(Object.keys(first!).sort(), Object.keys(second!).sort(), "the foreign journey is indistinguishable from a missing one");
    assert.equal(runsOf(foreign).length, 0);
    assert.equal(runsOf(decoy).length, 0);
  });

  it("nothing eligible: the model isn't told it can ask, and an executor that asks anyway still starts nothing", async () => {
    const missing = randomUUID();
    forceRequest = true;
    const a = asking("A", [target(missing)], { request: ask("journey_1") });
    await enroll(a);
    assert.equal(offeredTo(only(a)), undefined);
    assert.equal(orchestration(only(a))?.reason, "target_not_found");
  });

  it("the journey itself is never offered, asking for it is self_start, and activation refuses it", async () => {
    const id = randomUUID();
    const decoy = quick("Decoy");
    const a = asking("A", [target(id), target(decoy)], { request: ask("journey_1") }, { id });
    await enroll(a);
    assert.deepEqual(offeredTo(only(a))?.map((option) => option.key), ["journey_2"]);
    assert.equal(orchestration(only(a))?.reason, "self_start");
    assert.equal(runsOf(a).length, 1);
    const saved = store.journeys.get(a)!;
    const issues = activationIssues(saved.versions.get(saved.version)!, a);
    assert.ok(issues.some((issue) => /a journey can't start itself/.test(issue.message)), JSON.stringify(issues));
  });

  it("a key not in the list, or a real journey id the model guessed, is target_not_allowed", async () => {
    const [b, other] = [quick("B"), quick("Other")];
    for (const journeyKey of ["journey_2", "journey_0", other, b, "Journey_1", " journey_1"]) {
      const a = asking("A", [target(b)], { request: ask(journeyKey) });
      await enroll(a);
      assert.equal(orchestration(runsOf(a)[0])?.reason, "target_not_allowed", journeyKey);
    }
    assert.equal(runsOf(other).length, 0);
    assert.equal(runsOf(b).length, 0);
  });

  it("a target whose trigger isn't journey.started, or whose filters don't match, starts nothing", async () => {
    const manual = journey("Manual", "manual", [task("manual")]);
    const a = asking("A", [target(manual)], { request: ask("journey_1") });
    await enroll(a);
    assert.equal(orchestration(only(a))?.reason, "target_not_listening");
    assert.equal(runsOf(manual).length, 0);
  });
});

// ---------- Inputs ----------

describe("inputs: declared names, scalar values, Stage 3 limits", () => {
  it("text, numbers, yes/no, and null pass; a declared input the model left out is null", async () => {
    const b = quick("B");
    const a = asking("A", [target(b, ["area", "score", "ready", "note", "missing"])], {
      request: ask("journey_1", { area: "Austin", score: 7.5, ready: false, note: null }),
    });
    await enroll(a);
    assert.deepEqual(only(b).triggerPayload.inputs, { area: "Austin", score: 7.5, ready: false, note: null, missing: null });
  });

  it("a journey that takes no inputs gets none", async () => {
    const b = quick("B");
    const a = asking("A", [target(b)], { request: ask("journey_1") });
    await enroll(a);
    assert.equal(Object.hasOwn(only(b).triggerPayload, "inputs"), false);
  });

  for (const [label, value, reason] of [
    ["an object", { nested: true }, "inputs_invalid"],
    ["an array", ["a", "b"], "inputs_invalid"],
    ["Infinity", Infinity, "inputs_invalid"],
    ["NaN", Number.NaN, "inputs_invalid"],
    ["oversized text", "x".repeat(MAX_INPUTS_BYTES + 1), "inputs_too_large"],
  ] as const) {
    it(`${label} as a value starts nothing (${reason})`, async () => {
      const b = quick("B");
      const a = asking("A", [target(b, ["area"])], { request: ask("journey_1", { area: value }) });
      await enroll(a);
      assert.equal(orchestration(only(a))?.started, false);
      assert.equal(orchestration(only(a))?.reason, reason);
      assert.equal(runsOf(b).length, 0);
    });
  }

  it("an undeclared input name, or inputs that aren't named values, starts nothing (inputs_invalid)", async () => {
    const b = quick("B");
    for (const inputs of [{ area: "x", source: "lead.budget" }, { causation_depth: 0 }, "lead.budget", ["area"], 5]) {
      const a = asking("A", [target(b, ["area"])], { request: ask("journey_1", inputs) });
      await enroll(a);
      const result = orchestration(runsOf(a)[0]);
      assert.equal(result?.reason, "inputs_invalid", JSON.stringify(inputs));
      assert.equal(result?.journey, "journey_1");
    }
    assert.equal(runsOf(b).length, 0);
  });

  it("a value that looks like a source expression or template is passed as plain text, never resolved", async () => {
    const b = quick("B");
    const a = asking("A", [target(b, ["first", "second", "third"])], {
      request: ask("journey_1", { first: "lead.budget", second: "{{full_name}}", third: "steps.x.output.y" }),
    });
    await enroll(a);
    assert.deepEqual(only(b).triggerPayload.inputs, { first: "lead.budget", second: "{{full_name}}", third: "steps.x.output.y" });
    assert.ok(!JSON.stringify(only(b).triggerPayload).includes("500k"));
  });

  it("each journey only takes its own declared inputs: one journey's names don't carry to another", async () => {
    const [b, c] = [quick("B"), quick("C")];
    const a = asking("A", [target(b, ["area"]), target(c, ["score"])], { request: ask("journey_2", { area: "Austin" }) });
    await enroll(a);
    assert.equal(orchestration(only(a))?.reason, "inputs_invalid");
    assert.equal(runsOf(c).length, 0);
  });

  it("config limits: at most 10 journeys and 10 inputs each, names in the input pattern, a description required", () => {
    const tooMany = Array.from({ length: MAX_AGENT_JOURNEY_TARGETS + 1 }, () => target(randomUUID()));
    const errors = (targets: unknown) => validateNodeConfig("ai", { ...decider([]), orchestrationJourneys: targets }, "strict").errors;
    assert.ok(errors(tooMany).some((error) => /at most 10 journeys/.test(error)));
    assert.ok(errors([target(randomUUID(), Array.from({ length: 11 }, (_, i) => `in_${i}`))]).some((error) => /at most 10 inputs/.test(error)));
    assert.ok(errors([target(randomUUID(), ["Bad-Name"])]).some((error) => /lowercase letters/.test(error)));
    const long = validateNodeConfig("ai", { ...decider([target(randomUUID(), [`a${"b".repeat(80)}`])]) }, "draft").config as { orchestrationJourneys: Target[] };
    assert.equal(long.orchestrationJourneys[0].inputs?.[0].name.length, 60, "names are cut at 60, as Stage 3 input names");
    assert.ok(errors([target(randomUUID(), undefined, " ")]).some((error) => /describe when/.test(error)));
    assert.ok(errors([]).some((error) => /at least one journey/.test(error)));
    const id = randomUUID();
    assert.ok(errors([target(id), target(id.toUpperCase())]).some((error) => /already listed/.test(error)));
    assert.deepEqual(errors([target(randomUUID(), ["area"])]), []);
  });
});

// ---------- Forgery ----------

describe("the model can't supply anything the engine derives", () => {
  for (const field of ["causation_depth", "root_run_id", "origin_run_id", "origin_journey_id", "tenant_id", "workspace_id", "contact_id", "parent_run_id", "idempotency_key", "payload", "journeyId", "waitForCompletion", "journeys"]) {
    it(`a request with "${field}" is refused whole (invalid_request)`, async () => {
      const b = quick("B");
      const a = asking("A", [target(b)], { request: { journey: "journey_1", [field]: field === "causation_depth" ? 0 : "forged" } });
      await enroll(a);
      assert.deepEqual(orchestration(only(a)), {
        requested: true,
        action: "start_journey",
        started: false,
        reason: "invalid_request",
        request_errors: ["The request may only name a journey and its inputs."],
      });
      assert.equal(runsOf(b).length, 0);
    });
  }

  it("a malformed request (not an object, no journey) is invalid_request", async () => {
    const b = quick("B");
    for (const request of ["journey_1", ["journey_1"], 1, true, {}, { journey: 1 }, { inputs: {} }]) {
      const a = asking("A", [target(b)], { request });
      await enroll(a);
      assert.equal(orchestration(runsOf(a)[0])?.reason, "invalid_request", JSON.stringify(request));
    }
    assert.equal(runsOf(b).length, 0);
  });

  it("inputs named like lineage stay inside inputs: lineage, depth, contact, and tenant are the engine's", async () => {
    const other = randomUUID();
    const b = quick("B");
    const a = asking("A", [target(b, ["root_run_id", "causation_depth", "origin_run_id", "contact_id"])], {
      request: ask("journey_1", { root_run_id: "forged", causation_depth: -5, origin_run_id: other, contact_id: other }),
    });
    await enroll(a);
    const child = only(b);
    assert.equal(child.tenantId, tenant);
    assert.equal(child.contactId, contact);
    assert.equal(child.triggerPayload.root_run_id, only(a).id);
    assert.equal(child.triggerPayload.origin_run_id, only(a).id);
    assert.equal(child.triggerPayload.causation_depth, 1);
    assert.equal(runCausationDepth(child), 2);
    assert.equal(runRootId(child, child.id), only(a).id);
    assert.deepEqual(child.triggerPayload.inputs, { root_run_id: "forged", causation_depth: -5, origin_run_id: other, contact_id: other });
  });

  it("the model can't write output.orchestration itself: the engine's record replaces it, and without permission it's dropped", async () => {
    const b = quick("B");
    const forged = { requested: true, started: true, run_id: "forged", target_journey_id: b };
    const allowed = asking("A", [target(b)], { output: { orchestration: forged, score: 1 } });
    await enroll(allowed);
    assert.deepEqual(orchestration(only(allowed)), { requested: false, started: false });

    const denied = asking("D", null, { output: { orchestration: forged, score: 1 } });
    await enroll(denied);
    assert.equal(Object.hasOwn(stepAt(only(denied), 0).output, AI_ORCHESTRATION_KEY), false);
    assert.equal(runsOf(b).length, 0);
  });

  it("the parent's private context never crosses: the child gets lineage and declared inputs only", async () => {
    const b = quick("B");
    const a = asking("A", [target(b, ["area"])], { output: { secret_note: "PRIVATE" }, request: ask("journey_1", { area: "x" }) });
    await enroll(a);
    const payload = JSON.stringify(only(b).triggerPayload);
    for (const leaked of ["PRIVATE", "500k", "enrolled_by", "ai_response", "secret_note"]) assert.ok(!payload.includes(leaked), leaked);
  });
});

// ---------- Idempotency ----------

describe("idempotency: exactly one child per AI step per run", () => {
  it("the pass died mid AI step after the child was created: the repeat asks the model again and reuses the child", async () => {
    const b = slow("B");
    const a = asking("A", [target(b)], { request: ask("journey_1") });
    await enroll(a);
    const first = only(b);
    const live = store.runs.get(only(a).id)!;
    const step = stepAt(live, 0);
    step.status = "running";
    Object.assign(live, {
      status: "running", currentNodeId: `${a}-n0`, lockedUntil: null, completedAt: null,
      resumeAt: new Date(clock).toISOString(),
      context: { steps: {}, attempts: {}, inFlight: { nodeId: `${a}-n0`, stepId: step.id } },
    });

    await worker();
    assert.equal(only(b).id, first.id);
    assert.equal(aiRequests.filter((request) => request.runId === live.id).length, 2, "the model was asked again");
    assert.deepEqual(orchestration(only(a)), {
      requested: true, action: "start_journey", journey: "journey_1", target_journey_id: b, started: true, run_id: first.id, causation_depth: 1, duplicate: true,
    });
  });

  it("the child was created but the step failed: the retried step reuses it, even if the model now asks for another journey or none", async () => {
    const [b, c] = [slow("B"), slow("C")];
    const a = asking("A", [target(b), target(c)], (_request, call) => (call === 1 ? { request: ask("journey_1") } : call === 2 ? { request: ask("journey_2") } : {}));
    const create = store.createRun.bind(store);
    let calls = 0;
    store.createRun = async (input) => {
      const result = await create(input);
      if (++calls === 2) throw new Error("connection reset after insert");
      return result;
    };
    await enroll(a);
    store.createRun = create;
    assert.equal(only(a).status, "waiting", "transient: retried after backoff");
    const first = only(b);

    await worker(RETRY_BACKOFF_MS[0]);
    assert.equal(only(b).id, first.id);
    assert.equal(runsOf(c).length, 0, "a different request on the retry doesn't start a second child");
    assert.equal(orchestration(only(a))?.journey, "journey_1");
    assert.equal(orchestration(only(a))?.duplicate, true);
    assert.equal(only(a).status, "completed");
  });

  it("the run failed and was retried by hand: the retried AI step reuses the child", async () => {
    const b = slow("B");
    const a = asking("A", [target(b)], (_request, call) => (call === 1 ? { request: ask("journey_1") } : call <= MAX_ATTEMPTS ? { fail: "transient" } : { request: ask("journey_1") }));
    const create = store.createRun.bind(store);
    let calls = 0;
    store.createRun = async (input) => {
      const result = await create(input);
      if (++calls === 2) throw new Error("connection reset after insert");
      return result;
    };
    await enroll(a);
    store.createRun = create;
    for (let attempt = 0; attempt < MAX_ATTEMPTS && only(a).status !== "failed"; attempt++) await worker(RETRY_BACKOFF_MS.at(-1)!);
    assert.equal(only(a).status, "failed");
    assert.equal(runsOf(b).length, 1);

    const retried = await retryJourneyRun(store, retryLookups(), tenant, only(a).id, new Date(clock));
    assert.equal(retried.result, "retried");
    await worker();
    assert.equal(only(a).status, "completed");
    assert.equal(runsOf(b).length, 1);
    assert.equal(orchestration(only(a))?.duplicate, true);
  });

  it("redelivery of the parent's event, and racing passes, start one child", async () => {
    const b = slow("B");
    const a = asking("A", [target(b)], { request: ask("journey_1") });
    const sourceId = randomUUID();
    await enroll(a, { sourceId, execute: false });
    await enroll(a, { sourceId, execute: false });
    const parent = only(a);
    await Promise.all([executeRun(deps, parent.id), executeRun(deps, parent.id), worker(), worker()]);
    await enroll(a, { sourceId });
    assert.equal(runsOf(a).length, 1);
    assert.equal(runsOf(b).length, 1);
    assert.equal(stepsAt(only(a), 0).length, 1);
  });

  it("an identical request on every attempt resolves to the same run key, so the dispatcher can't create a second child", async () => {
    const b = quick("B");
    const a = asking("A", [target(b)], { request: ask("journey_1") });
    await enroll(a);
    const findRun = store.findRunByIdempotencyKey.bind(store);
    store.findRunByIdempotencyKey = async () => null; // the step's own lookup misses; the run key still holds
    const live = store.runs.get(only(a).id)!;
    stepAt(live, 0).status = "running";
    Object.assign(live, {
      status: "running", currentNodeId: `${a}-n0`, lockedUntil: null, completedAt: null, resumeAt: new Date(clock).toISOString(),
      context: { steps: {}, attempts: {}, inFlight: { nodeId: `${a}-n0`, stepId: stepAt(live, 0).id } },
    });
    await worker();
    store.findRunByIdempotencyKey = findRun;
    assert.equal(stepsAt(only(a), 0).length, 2, "the AI step ran again");
    assert.equal(runsOf(b).length, 1);
    assert.equal(orchestration(only(a))?.duplicate, true);
  });

  for (const [label, retryAnswer] of [
    ["a different journey", { request: ask("journey_2") }],
    ["no journey", {}],
  ] as const) {
    it(`the child was created, the step failed, and the retry's model asks for ${label}: the original child stays the step's child`, async () => {
      const [b, c] = [slow("B"), slow("C")];
      const a = asking("A", [target(b), target(c)], (_request, call) => (call === 1 ? { request: ask("journey_1") } : retryAnswer));
      const create = store.createRun.bind(store);
      store.createRun = async (input) => {
        const result = await create(input);
        if (input.journeyId === b) throw new Error("connection reset after insert");
        return result;
      };
      await enroll(a);
      store.createRun = create;
      const first = only(b);

      await worker(RETRY_BACKOFF_MS[0]);
      assert.equal(only(b).id, first.id);
      assert.equal(runsOf(c).length, 0);
      assert.deepEqual(orchestration(only(a)), {
        requested: true, action: "start_journey", journey: "journey_1", target_journey_id: b, started: true, run_id: first.id, causation_depth: 1, duplicate: true,
      });
      assert.equal(only(a).status, "completed");
    });
  }
});

// ---------- Overlapping passes ----------

describe("overlapping passes of one AI step: still at most one child", () => {
  /** Enrolls the lead with the run left due, so the test runs (and interleaves) its passes. */
  async function enrolled(journeyId: string) {
    await enroll(journeyId, { execute: false });
    return only(journeyId);
  }

  /** What another pass of `parent`'s AI step (n0) inserts when its model picked `targetId`: the same journey.started event. */
  const otherPassStarts = (parent: MemoryRun, targetId: string) =>
    dispatchJourneyEvent(
      deps,
      {
        tenantId: tenant, type: "journey.started", sourceId: `${parent.id}:${parent.journeyId}-n0`, journeyId: targetId,
        contactId: contact, entityType: "contact", entityId: contact,
        payload: { origin: "journey", origin_run_id: parent.id, origin_journey_id: parent.journeyId, root_run_id: parent.id, causation_depth: 1, requested_by: "ai_step" },
      },
      { execute: false },
    );

  /** Runs `meanwhile` while this pass is past its existing-child check and its run-key lookup, just before it inserts. */
  function beforeNextInsert(meanwhile: () => Promise<unknown>) {
    const check = store.hasActiveRun.bind(store);
    let armed = true;
    store.hasActiveRun = async (...args) => {
      if (armed) {
        armed = false;
        await meanwhile();
      }
      return check(...args);
    };
  }

  const childOf = (run: MemoryRun) => runs().filter((entry) => entry.triggerPayload.origin_run_id === run.id);

  it("both passes pick the same journey: one child, reported as the step's child", async () => {
    const b = slow("B");
    const parent = await enrolled(asking("A", [target(b)], { request: ask("journey_1") }));
    beforeNextInsert(() => otherPassStarts(parent, b));
    await executeRun(deps, parent.id);

    assert.equal(childOf(parent).length, 1);
    assert.deepEqual(orchestration(only(parent.journeyId)), {
      requested: true, action: "start_journey", journey: "journey_1", target_journey_id: b, started: true, run_id: only(b).id, causation_depth: 1, duplicate: true,
    });
  });

  it("the other pass picked journey_1 and inserted first; this pass picked journey_2: one child (journey_1's), and this pass reports it", async () => {
    const [b, c] = [slow("B"), slow("C")];
    const parent = await enrolled(asking("A", [target(b), target(c)], { request: ask("journey_2") }));
    beforeNextInsert(() => otherPassStarts(parent, b));
    await executeRun(deps, parent.id);

    assert.equal(childOf(parent).length, 1, "only one child of the AI step");
    assert.equal(runsOf(c).length, 0, "journey_2's insert was refused");
    assert.deepEqual(orchestration(only(parent.journeyId)), {
      requested: true, action: "start_journey", journey: "journey_1", target_journey_id: b, started: true, run_id: only(b).id, causation_depth: 1, duplicate: true,
    });

    // The first inserted child stays the step's child for every later attempt, whatever the model asks.
    const live = store.runs.get(parent.id)!;
    stepAt(live, 0).status = "running";
    Object.assign(live, {
      status: "running", currentNodeId: `${parent.journeyId}-n0`, lockedUntil: null, completedAt: null, resumeAt: new Date(clock).toISOString(),
      context: { steps: {}, attempts: {}, inFlight: { nodeId: `${parent.journeyId}-n0`, stepId: stepAt(live, 0).id } },
    });
    await worker();
    assert.equal(childOf(parent).length, 1);
    assert.equal(orchestration(only(parent.journeyId))?.run_id, only(b).id);
  });

  it("a stalled pass loses its lease mid model call; the pass that took over starts journey_2; the stalled pass, answering journey_1, starts nothing", async () => {
    const [b, c] = [slow("B"), slow("C")];
    // Model calls in order: the pass that took over answers first (journey_2), the stalled one last (journey_1).
    const parent = await enrolled(asking("A", [target(b), target(c)], (_request, call) => ({ request: ask(call === 1 ? "journey_2" : "journey_1") })));
    const model = deps.ai;
    let stalled = true;
    deps.ai = {
      async execute(request) {
        if (stalled) {
          stalled = false;
          store.runs.get(parent.id)!.lockedUntil = new Date(clock - 1).toISOString();
          const takeover = await executeRun(deps, parent.id);
          assert.equal(takeover.status, "completed");
        }
        return model.execute(request);
      },
    };
    const outcome = await executeRun(deps, parent.id);
    deps.ai = model;

    assert.equal(outcome.status, "lease_lost");
    assert.equal(childOf(parent).length, 1);
    assert.equal(runsOf(b).length, 0);
    assert.equal(orchestration(only(parent.journeyId))?.journey, "journey_2");
    assert.equal(orchestration(only(parent.journeyId))?.run_id, only(c).id);
    assert.equal(only(parent.journeyId).status, "completed");
  });

  it("something else starts the chosen journey for the lead in between: not adopted, already_active, no child", async () => {
    const b = slow("B");
    const x = journey("X", "manual", [{ action: "start_journey", journeyId: b }]);
    const parent = await enrolled(asking("A", [target(b)], { request: ask("journey_1") }));
    beforeNextInsert(() => enroll(x));
    await executeRun(deps, parent.id);

    assert.equal(childOf(parent).length, 0);
    assert.equal(only(b).triggerPayload.origin_journey_id, x);
    assert.deepEqual(orchestration(only(parent.journeyId)), {
      requested: true, action: "start_journey", journey: "journey_1", target_journey_id: b, started: false, reason: "already_active",
    });
  });
});

// ---------- Causation ----------

describe("causation: the same depth cap as authored Start journey chains", () => {
  /** A → B → C → D → E, each asking (or, authored, starting) the next. Returns which journeys got a run. */
  async function chain(mode: "agent" | "authored") {
    const ids = Array.from({ length: 5 }, () => randomUUID());
    ids.forEach((id, index) => {
      const name = `${mode}${index}`;
      const event = index === 0 ? "manual" : "journey.started";
      const next = ids[index + 1];
      if (!next) return void journey(name, event, [task(name)], { id });
      if (mode === "agent") asking(name, [target(next)], { request: ask("journey_1") }, { id, event });
      else journey(name, event, [{ action: "start_journey", journeyId: next }, task(name)], { id });
    });
    await enroll(ids[0]);
    for (let i = 0; i < 5; i++) await worker();
    return ids.map((id) => runsOf(id));
  }

  it("depth 1 → 2 → 3, then depth_limited with no child, exactly as an authored chain", async () => {
    const agent = await chain("agent");
    const authored = await chain("authored");
    assert.deepEqual(agent.map((list) => list.length), authored.map((list) => list.length));
    assert.deepEqual(agent.map((list) => list.length), [1, 1, 1, 0, 0]);
    assert.deepEqual(agent.slice(0, 3).map(([run]) => runCausationDepth(run)), [1, 2, 3]);
    assert.equal(orchestration(agent[2][0])?.reason, "depth_limited");
    assert.equal(orchestration(agent[2][0])?.causation_depth, 3);
    assert.equal(agent[1][0].triggerPayload.root_run_id, agent[0][0].id);
    assert.equal(agent[2][0].triggerPayload.root_run_id, agent[0][0].id);
    assert.equal(agent[2][0].triggerPayload.origin_run_id, agent[1][0].id);
  });

  it("agent and authored hops share one depth: an AI-requested child's own Start journey step is still capped", async () => {
    const [c, d] = [randomUUID(), randomUUID()];
    journey("D", "journey.started", [task("d")], { id: d });
    journey("C", "journey.started", [{ action: "start_journey", journeyId: d }, task("c")], { id: c });
    const b = asking("B", [target(c)], { request: ask("journey_1") }, { event: "journey.started" });
    const a = journey("A", "manual", [{ action: "start_journey", journeyId: b }, task("a")]);
    await enroll(a);
    for (let i = 0; i < 4; i++) await worker();
    assert.equal(runCausationDepth(only(c)), 3);
    assert.equal(runsOf(d).length, 0);
    assert.equal(stepAt(only(c), 0).output.skipped_reason, "depth_limited");
  });
});

// ---------- Existing active run ----------

describe("one active run per lead", () => {
  it("the lead is already in the target: already_active, nothing attached, nothing created, nothing waited for", async () => {
    const b = slow("B");
    await enroll(journey("X", "manual", [{ action: "start_journey", journeyId: b }]));
    const existing = only(b);
    assert.equal(existing.status, "waiting");

    const a = asking("A", [target(b)], { request: ask("journey_1") });
    await enroll(a);
    assert.equal(only(b).id, existing.id);
    assert.deepEqual(orchestration(only(a)), { requested: true, action: "start_journey", journey: "journey_1", target_journey_id: b, started: false, reason: "already_active" });
    assert.equal(only(a).status, "completed");
    assert.equal(only(a).context.waitingForChild, undefined);
  });

  it("another lead's active run in the target doesn't block or attach: this lead gets its own child", async () => {
    const b = slow("B");
    const otherContact = randomUUID();
    store.contacts.set(otherContact, { tenantId: tenant, lead: { lead_status: "New" } });
    const first = asking("A", [target(b)], { request: ask("journey_1") });
    await enroll(first, { contactId: otherContact });
    await enroll(first);
    const children = runsOf(b);
    assert.equal(children.length, 2);
    assert.deepEqual(children.map((run) => run.contactId).sort(), [contact, otherContact].sort());
  });
});

// ---------- Output and errors ----------

describe("output: deterministic and free of internal errors", () => {
  it("a store failure while starting becomes a retried step error; it never reaches the step output, the context, or the model", async () => {
    const b = quick("B");
    const a = asking("A", [target(b)], { request: ask("journey_1") });
    const create = store.createRun.bind(store);
    let calls = 0;
    store.createRun = async (input) => {
      if (++calls === 2) throw new Error("duplicate key value violates constraint journey_runs_pkey (secret detail)");
      return create(input);
    };
    await enroll(a);
    store.createRun = create;
    assert.equal(only(a).status, "waiting");
    assert.ok(!JSON.stringify(only(a).context).includes("secret detail"));

    await worker(RETRY_BACKOFF_MS[0]);
    assert.equal(only(a).status, "completed");
    assert.ok(!JSON.stringify(stepAt(only(a), 0).output).includes("secret"));
    assert.ok(!JSON.stringify(aiRequests.map((request) => request.context)).includes("secret detail"));
    assert.equal(orchestration(only(a))?.started, true);
  });

  it("the same answer gives the same record: only engine-chosen keys, no model text", async () => {
    const b = quick("B");
    const a = asking("A", [target(b)], { request: ask("journey_1") });
    await enroll(a);
    assert.deepEqual(Object.keys(orchestration(only(a))!).sort(), ["action", "causation_depth", "journey", "requested", "run_id", "started", "target_journey_id"]);
  });
});

// ---------- Children use the full engine ----------

describe("an AI-requested child is an ordinary started journey", () => {
  it("it can start, wait for, and receive results from its own children, and fan out; the AI step's run never waits", async () => {
    const [g1, g2] = [slow("G1"), slow("G2")];
    const resultId = randomUUID();
    answers.set(`${resultId}-n0`, () => ({ output: { decision: "approved" } }));
    const g3 = journey("G3", "journey.started", [{ type: "ai", goal: "decide", instructions: "", agent: "default" }, task("g3")], {
      id: resultId,
      results: (id) => [{ name: "decision", source: out(id, 0, "decision") }],
    });
    const b = journey("B", "journey.started", [
      { action: "start_journeys", journeys: [{ journeyId: g1 }, { journeyId: g2 }], waitForCompletion: true, completion: "all" },
      { action: "start_journey", journeyId: g3, waitForCompletion: true, resultMappings: [{ target: "decision", source: "result.decision" }] },
      task("b"),
    ]);
    const a = asking("A", [target(b)], { request: ask("journey_1") });
    await enroll(a);
    assert.equal(only(a).status, "completed", "the requesting run continued at once");
    assert.equal(only(b).status, "waiting");

    await worker(DAY);
    await worker();
    await worker();
    assert.equal(only(b).status, "completed");
    assert.deepEqual(stepAt(only(b), 1).output.results, { decision: "approved" });
    assert.equal(runCausationDepth(only(g1)), 3);
    assert.equal(only(g1).triggerPayload.root_run_id, only(a).id);
    assert.equal(Object.hasOwn(only(g1).triggerPayload, "requested_by"), false, "authored starts aren't marked as AI-requested");
  });

  it("the requesting AI step can't read the child's results: there's no result contract for it", async () => {
    const resultId = randomUUID();
    answers.set(`${resultId}-n0`, () => ({ output: { decision: "approved" } }));
    const b = journey("B", "journey.started", [{ type: "ai", goal: "d", instructions: "", agent: "default" }], {
      id: resultId,
      results: (id) => [{ name: "decision", source: out(id, 0, "decision") }],
    });
    const a = asking("A", [target(b)], { request: ask("journey_1") });
    await enroll(a);
    await worker();
    assert.equal(only(b).status, "completed");
    assert.ok(!JSON.stringify(only(a).context).includes("approved"));
    assert.equal(Object.hasOwn(orchestration(only(a))!, "results"), false);
  });
});

// ---------- Graph and conditions ----------

describe("graph and condition fields", () => {
  const aiNode = (config: Step): SnapshotNode => ({ id: "ai-1", type: "ai", name: "Decide", description: "", config });

  it("orchestration fields exist only on an AI step allowed to ask for a journey", () => {
    const allowed = aiNode(decider([target(randomUUID())]));
    assert.equal(knownOutputFields(allowed), null, "freeform: fields typed by the designer");
    const structured = aiNode({ ...decider([target(randomUUID())]), outputSchema: [{ name: "score", type: "number", description: "" }] });
    assert.deepEqual(knownOutputFields(structured), [
      "score", "ai_response",
      "orchestration.requested", "orchestration.started", "orchestration.reason", "orchestration.journey",
      "orchestration.target_journey_id", "orchestration.run_id", "orchestration.causation_depth",
    ]);
    assert.deepEqual(knownOutputFields(aiNode({ ...decider(null), outputSchema: [{ name: "score", type: "number", description: "" }] })), ["score", "ai_response"]);
  });

  it("activation refuses a condition on orchestration.* of a step that isn't allowed, and a reserved output field name", () => {
    const build = (ai: Step) => {
      const id = randomUUID();
      return {
        id,
        snapshot: {
          nodes: [
            { id: `${id}-t`, type: "trigger", name: "T", description: "", config: { event: "manual", filters: [] } },
            { id: `${id}-n0`, type: "ai", name: "Decide", description: "", config: ai },
            { id: `${id}-c`, type: "condition", name: "C", description: "", config: { field: out(id, 0, "orchestration.started"), operator: "equals", value: true } },
          ],
          connections: [
            { id: "1", sourceNodeId: `${id}-t`, targetNodeId: `${id}-n0`, sourceHandle: null, targetHandle: null },
            { id: "2", sourceNodeId: `${id}-n0`, targetNodeId: `${id}-c`, sourceHandle: null, targetHandle: null },
          ],
        } as JourneySnapshot,
      };
    };
    const denied = build(decider(null));
    assert.ok(activationIssues(denied.snapshot, denied.id).some((issue) => /isn't an AI step allowed to start a journey/.test(issue.message)));
    const allowed = build(decider([target(randomUUID())]));
    const pathOnly = (issues: Array<{ message: string }>) => issues.filter((issue) => !/needs a Yes or No path/.test(issue.message));
    assert.deepEqual(pathOnly(activationIssues(allowed.snapshot, allowed.id)), []);
    assert.ok(
      validateNodeConfig("ai", { ...decider(null), outputSchema: [{ name: "orchestration", type: "string", description: "" }] }, "strict").errors.some((error) => /reserved/.test(error)),
    );
  });

  it("the resolver reads own fields of output.orchestration only", () => {
    const record = Object.create({ started: true }) as Record<string, unknown>;
    record.reason = "already_active";
    const context: ExecutionContext = { lead: null, opportunity: null, trigger: { event: "manual", payload: {} }, steps: { s: { output: { orchestration: record } } } };
    assert.equal(resolveField(context, "steps.s.output.orchestration.reason"), "already_active");
    assert.equal(resolveField(context, "steps.s.output.orchestration.started"), undefined);
    assert.equal(resolveField(context, "steps.s.output.orchestration.bogus"), undefined);
  });
});

// ---------- Request parsing and the executor boundary ----------

describe("request parsing and the AI executor boundary", () => {
  it("allowed journeys keep their designer-list keys; invalid and repeated rows are skipped", () => {
    const [b, c] = [randomUUID(), randomUUID()];
    const allowed = allowedAgentJourneys({ allowJourneyOrchestration: true, orchestrationJourneys: [target(b), target("not-a-uuid"), target(b), target(c)] });
    assert.deepEqual(allowed?.map((entry) => [entry.key, entry.target.journeyId]), [["journey_1", b], ["journey_4", c]]);
    assert.equal(allowedAgentJourneys({ orchestrationJourneys: [target(b)] }), null, "the list alone doesn't allow anything");
  });

  it("error text never echoes the model's values", () => {
    const allowed = allowedAgentJourneys({ allowJourneyOrchestration: true, orchestrationJourneys: [target(randomUUID(), ["area"])] })!;
    const parsed = parseAgentJourneyRequest({ journey: "journey_1", inputs: { "<script>": 1, ok_name: 2 } }, allowed);
    assert.equal(parsed.ok, false);
    assert.ok(!JSON.stringify(parsed).includes("<script>"));
  });

  function executor(raw: string) {
    return createJourneyAIExecutor({
      model: { isConfigured: async () => true, complete: async () => raw },
      conversation: { recent: async () => [] },
    });
  }
  const request = (extra: Partial<JourneyAIRequest> = {}): JourneyAIRequest => ({
    tenantId: tenant, journeyId: randomUUID(), runId: randomUUID(), nodeId: "n", stepKey: "s", contactId: null, agent: "default",
    goal: "Decide", instructions: "", outputSchema: [], context: { lead: null, opportunity: null, trigger: { event: "manual", payload: {} }, steps: {} },
    ...extra,
  });
  const options = [{ key: "journey_1", description: "Ready", inputs: [{ name: "area", description: "" }] }];

  it("the executor passes start_journey on unchecked only when journeys were offered, and keeps it out of output", async () => {
    const raw = JSON.stringify({ output: { score: 1, orchestration: { started: true } }, text: "t", [JOURNEY_REQUEST_KEY]: { journey: "journey_1", inputs: { area: "x" } } });
    const offered = await executor(raw).execute(request({ journeyOptions: options }));
    assert.deepEqual(offered, { success: true, output: { score: 1 }, text: "t", journeyRequest: { journey: "journey_1", inputs: { area: "x" } } });
    const notOffered = await executor(raw).execute(request());
    assert.deepEqual(notOffered, { success: true, output: { score: 1 }, text: "t" });
  });

  it("a flat answer's start_journey isn't an output field; null asks for nothing; an oversized request is passed on as malformed", async () => {
    const flat = await executor(JSON.stringify({ score: 1, [JOURNEY_REQUEST_KEY]: null })).execute(request({ journeyOptions: options }));
    assert.deepEqual(flat, { success: true, output: { score: 1 }, text: "" });
    const huge = await executor(JSON.stringify({ output: { score: 1 }, text: "", [JOURNEY_REQUEST_KEY]: { journey: "journey_1", inputs: { area: "x".repeat(5000) } } })).execute(
      request({ journeyOptions: options }),
    );
    assert.equal(huge.success && huge.journeyRequest, "malformed");
  });

  it("structured steps: the strict schema adds start_journey (null or one offered key with its exact inputs) only when offered", () => {
    const schema = [{ name: "score", type: "number" as const, description: "" }];
    const withOptions = buildJourneyAIPrompt(request({ outputSchema: schema, journeyOptions: options }), [], new Date()).responseSchema!;
    assert.deepEqual((withOptions.required as string[]).sort(), ["output", JOURNEY_REQUEST_KEY, "text"].sort());
    assert.deepEqual((withOptions.properties as Record<string, unknown>)[JOURNEY_REQUEST_KEY], {
      anyOf: [
        { type: "null" },
        {
          type: "object",
          properties: {
            journey: { type: "string", enum: ["journey_1"] },
            inputs: { type: "object", properties: { area: { type: ["string", "number", "boolean", "null"] } }, required: ["area"], additionalProperties: false },
          },
          required: ["journey", "inputs"],
          additionalProperties: false,
        },
      ],
    });
    const without = buildJourneyAIPrompt(request({ outputSchema: schema }), [], new Date());
    assert.deepEqual(without.responseSchema!.required, ["output", "text"]);
    assert.ok(!without.system.includes(JOURNEY_REQUEST_KEY));
  });
});
