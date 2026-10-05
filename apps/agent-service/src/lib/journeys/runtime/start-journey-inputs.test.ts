/**
 * Start journey inputs: a start_journey step passes only the values it maps
 * (inputMappings) to the started run as trigger_payload.inputs, read there as
 * trigger.inputs.<name>. Real engine, dispatcher, memory store, outbox
 * dispatcher, and run retry.
 */

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { beforeEach, describe, it } from "node:test";
import type { JourneyAIExecutor, JourneyAIRequest } from "./ai.ts";
import {
  INPUT_SOURCE_MAX,
  MAX_INPUT_MAPPINGS,
  MAX_INPUTS_BYTES,
  nodeReferenceKey,
  validateNodeConfig,
  type ConditionRule,
  type InputMapping,
} from "./contracts.ts";
import { journeyInputs, resolveField, type ExecutionContext } from "./conditions.ts";
import {
  dispatchJourneyEvent,
  executeRun,
  JourneyStepError,
  resumeDueRuns,
  runCausationDepth,
  type ActionExecutor,
  type EngineDeps,
  type JourneyEvent,
} from "./engine.ts";
import { activationIssues, type JourneySnapshot, type SnapshotNode } from "./graph.ts";
import {
  DEFAULT_OUTBOX_OPTIONS,
  dispatchLeadStatusEvents,
  type LeadStatusEventRow,
  type LeadStatusOutbox,
} from "./lead-status-outbox.ts";
import { MemoryJourneyStore, type MemoryRun } from "./memory-store.ts";
import { retryJourneyRun, type RunRetryLookups } from "./run-retry.ts";

let store: MemoryJourneyStore;
let deps: EngineDeps;
let tenant: string;
let contact: string;
let names: Map<string, string>;
/** "<journey>:<task title or action>" for every non-engine action, in order. */
let performed: string[];
/** Journey names whose next Create task fails (once each). */
let failNextTask: Set<string>;
/** AI step outputs by node id. */
let aiOutputs: Map<string, Record<string, unknown>>;
let aiRequests: JourneyAIRequest[];
let pending: LeadStatusEventRow[];

const LINEAGE_KEYS = ["causation_depth", "origin", "origin_journey_id", "origin_run_id", "root_run_id"];

const outbox: LeadStatusOutbox = {
  async claim() {
    const rows = pending;
    pending = [];
    return rows;
  },
  async complete() {},
  async fail() {
    return "retry";
  },
  async originRun(row) {
    const run = [...store.runs.values()].find((entry) => entry.id === row.origin_run_id && entry.tenantId === row.tenant_id);
    return run ? { journeyId: run.journeyId, triggerEvent: run.triggerEvent, triggerPayload: run.triggerPayload } : null;
  },
};

beforeEach(() => {
  store = new MemoryJourneyStore();
  tenant = randomUUID();
  contact = randomUUID();
  names = new Map();
  performed = [];
  failNextTask = new Set();
  aiOutputs = new Map();
  aiRequests = [];
  pending = [];
  store.contacts.set(contact, {
    tenantId: tenant,
    lead: { lead_status: "New", record_type: "lead", budget: "500k", qualification_score: 72, ready_to_book: true, email: "lead@example.com" },
    opportunity: { stage: "Qualified" },
  });

  const ai: JourneyAIExecutor = {
    async execute(request) {
      aiRequests.push(structuredClone(request));
      return { success: true, output: aiOutputs.get(request.nodeId) ?? {}, text: "Because the lead said so." };
    },
  };
  const actions: ActionExecutor = {
    async execute(action, input) {
      const journeyName = names.get(input.nodeId.slice(0, 36)) ?? "?";
      if (action.action === "create_task" && failNextTask.delete(journeyName)) {
        throw new JourneyStepError("Task service rejected the task.", "config");
      }
      if (action.action === "update_lead" && input.contactId) {
        const lead = store.contacts.get(input.contactId)!.lead;
        const from = lead.lead_status as string;
        Object.assign(lead, action.fields);
        if (typeof action.fields.lead_status === "string") {
          pending.push({
            id: randomUUID(), tenant_id: input.tenantId, contact_id: input.contactId, from_status: from,
            to_status: action.fields.lead_status, origin: "journey", actor_user_id: null, origin_run_id: input.runId,
            converted: false, changed_at: new Date().toISOString(), created_at: new Date().toISOString(), attempt_count: 1,
            claim_token: randomUUID(),
          });
        }
      }
      performed.push(`${journeyName}:${action.action === "create_task" ? action.title : action.action}`);
      return { status: "completed", output: {} };
    },
  };
  deps = { store, actions, ai };
});

type Step = Record<string, unknown> & { type?: "action" | "ai" };
const task = (title = "Follow up"): Step => ({ action: "create_task", title, notes: "", dueInDays: 1 });
const start = (journeyId: string, inputMappings?: unknown): Step =>
  inputMappings === undefined ? { action: "start_journey", journeyId } : { action: "start_journey", journeyId, inputMappings };
const setLead = (fields: Record<string, unknown>): Step => ({ action: "update_lead", fields });
const aiStep = (): Step => ({ type: "ai", goal: "Score the lead", instructions: "", agent: "default" });
const waitDay: Step = { action: "wait", duration: 1, unit: "days" };
const map = (target: string, source: string): InputMapping => ({ target, source });

/** Trigger → steps in order. Node ids are `<journey id>-n<index>`; the trigger is `<journey id>-t`. */
function journey(
  name: string,
  event: string,
  steps: Step[],
  { filters = [] as ConditionRule[], tenantId = tenant, id = randomUUID() } = {},
) {
  names.set(id, name);
  const nodes: SnapshotNode[] = [
    { id: `${id}-t`, type: "trigger", name: "Trigger", description: "", config: { event, filters } },
    ...steps.map(({ type = "action", ...config }, index): SnapshotNode => ({ id: `${id}-n${index}`, type, name: `Step ${index}`, description: "", config })),
  ];
  store.saveJourney(tenantId, id, {
    nodes,
    connections: nodes.slice(1).map((node, index) => ({ id: `${id}-c${index}`, sourceNodeId: nodes[index].id, targetNodeId: node.id, sourceHandle: null, targetHandle: null })),
  });
  return id;
}

/** journey.started trigger → Condition → yes task / no task. */
function conditional(name: string, condition: Record<string, unknown>) {
  const id = randomUUID();
  names.set(id, name);
  const node = (suffix: string, type: SnapshotNode["type"], config: Record<string, unknown>): SnapshotNode => ({ id: `${id}-${suffix}`, type, name: suffix, description: "", config });
  const link = (source: string, target: string, sourceHandle: string | null = null) => ({ id: `${source}>${target}`, sourceNodeId: `${id}-${source}`, targetNodeId: `${id}-${target}`, sourceHandle, targetHandle: null });
  store.saveJourney(tenant, id, {
    nodes: [
      node("t", "trigger", { event: "journey.started", filters: [] }),
      node("c", "condition", condition),
      node("y", "action", task("yes")),
      node("n", "action", task("no")),
    ],
    connections: [link("t", "c"), link("c", "y", "yes"), link("c", "n", "no")],
  });
  return id;
}

async function enroll(journeyId: string, contactId: string | null = contact, tenantId = tenant) {
  return dispatchJourneyEvent(deps, {
    tenantId, type: "manual", journeyId, sourceId: randomUUID(), contactId, entityType: "contact", entityId: contactId, payload: { enrolled_by: "user" },
  });
}

async function drainOutbox() {
  for (let round = 0; round < 20 && pending.length > 0; round++) {
    await dispatchLeadStatusEvents(outbox, (event) => dispatchJourneyEvent(deps, event), { ...DEFAULT_OUTBOX_OPTIONS, budgetMs: 60_000 }, Date.now, () => {});
  }
  assert.equal(pending.length, 0, "outbox drained");
}

const runs = (): MemoryRun[] => [...store.runs.values()];
const runsOf = (journeyId: string) => runs().filter((run) => run.journeyId === journeyId);
const only = (journeyId: string) => {
  const list = runsOf(journeyId);
  assert.equal(list.length, 1, `exactly one ${names.get(journeyId)} run`);
  return list[0];
};
const stepAt = (run: MemoryRun, index: number) => store.stepsFor(run.id).filter((step) => step.nodeId === `${run.journeyId}-n${index}`).at(-1)!;
/** steps.<node-id key>.output.<field> for node <journey>-n<index>. */
const stepRef = (journeyId: string, index: number, field: string) => `steps.${nodeReferenceKey(`${journeyId}-n${index}`)}.output.${field}`;

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

async function retry(run: MemoryRun) {
  assert.equal((await retryJourneyRun(store, retryLookups(), tenant, run.id, new Date())).result, "retried");
  await resumeDueRuns(deps);
}

function rewind(run: MemoryRun, index: number) {
  Object.assign(store.runs.get(run.id)!, { status: "running", currentNodeId: `${run.journeyId}-n${index}`, lockedUntil: null, completedAt: null, resumeAt: new Date().toISOString() });
}

const validate = (inputMappings: unknown, mode: "draft" | "strict" = "strict") =>
  validateNodeConfig("action", { action: "start_journey", journeyId: randomUUID(), inputMappings }, mode);

// ---------- Contract ----------

describe("contract", () => {
  it("accepts explicit mappings from lead, opportunity, event, step output, and journey input fields", () => {
    const mappings = [
      map("budget", "lead.budget"),
      map("stage", "opportunity.stage"),
      map("to_status", "trigger.to_status"),
      map("score", "steps.abc_1.output.score"),
      map("tier", "trigger.inputs.tier"),
    ];
    const journeyId = randomUUID();
    const result = validateNodeConfig("action", { action: "start_journey", journeyId, inputMappings: mappings.map((m) => ({ ...m, extra: 1 })) }, "strict");
    assert.deepEqual(result, { config: { action: "start_journey", journeyId, inputMappings: mappings }, errors: [] });
  });

  it("no mappings (absent or empty) keeps the Stage 2 config shape", () => {
    const journeyId = randomUUID();
    for (const inputMappings of [undefined, []]) {
      assert.deepEqual(validateNodeConfig("action", { action: "start_journey", journeyId, inputMappings }, "strict"), {
        config: { action: "start_journey", journeyId },
        errors: [],
      });
    }
  });

  it("rejects a malformed list or entry", () => {
    for (const inputMappings of [{ budget: "lead.budget" }, "lead.budget", null, 3]) {
      assert.deepEqual(validate(inputMappings).errors, ["Inputs: the input list is malformed."]);
    }
    assert.deepEqual(validate([map("a", "lead.budget"), "x", [1], null]).errors, ["Input 2 is malformed.", "Input 3 is malformed.", "Input 4 is malformed."]);
  });

  it("rejects a missing, malformed, over-long, or repeated name", () => {
    assert.deepEqual(validate([map("", "lead.budget")]).errors, ["Input 1: enter a name."]);
    for (const target of ["Budget", "1st", "a-b", "__proto__", "inputs.x", "a b"]) {
      assert.deepEqual(validate([map(target, "lead.budget")]).errors, ["Input 1: use lowercase letters, numbers, and underscores, starting with a letter."], target);
    }
    // Names are stored up to 60 characters; a longer one is cut and still has to be unique.
    assert.deepEqual(validate([map(`a${"b".repeat(59)}`, "lead.budget")]).errors, []);
    assert.deepEqual(validate([map("budget", "lead.budget"), map("budget", "lead.email")]).errors, ['Input "budget" is used more than once.']);
  });

  it("rejects a missing or unsupported source: no arbitrary paths, whole objects, or Condition-only fields", () => {
    const bad = [
      "", "steps", "steps.qualify", "steps.qualify.output", "steps.qualify.output.a.b", "context.steps", "trigger",
      "trigger.payload", "trigger.inputs", "trigger.inputs.Tier", "trigger.origin_run_id", "lead", "lead.*", "lead.__proto__",
      "lead.tenant_id", "lead.id", "opportunity", "run.context", "lead.has_replied_since_journey_start", "{{lead.budget}}",
    ];
    for (const source of bad) {
      assert.deepEqual(validate([map("a", source)]).errors, ['Input "a": choose the value to pass.'], source);
    }
    assert.deepEqual(validate([{ target: "a", source: 7 }]).errors, ['Input "a": choose the value to pass.']);
    assert.deepEqual(validate([map("a", `steps.${"a".repeat(61)}.output.x`)]).errors, ['Input "a": choose the value to pass.']);
    assert.ok(`steps.${"a".repeat(60)}.output.${"b".repeat(60)}`.length <= INPUT_SOURCE_MAX);
  });

  it(`rejects more than ${MAX_INPUT_MAPPINGS} mappings`, () => {
    const many = Array.from({ length: MAX_INPUT_MAPPINGS + 1 }, (_, i) => map(`v${i}`, "lead.budget"));
    assert.deepEqual(validate(many).errors, [`Pass at most ${MAX_INPUT_MAPPINGS} inputs.`]);
    assert.deepEqual(validate(many.slice(0, MAX_INPUT_MAPPINGS)).errors, []);
  });

  it("drafts keep half-typed rows without errors; activation flags them", () => {
    const draft = validate([map("", ""), map("budget", "")], "draft");
    assert.deepEqual(draft.errors, []);
    assert.deepEqual(draft.config.inputMappings, [map("", ""), map("budget", "")]);
    assert.deepEqual(validate(draft.config.inputMappings).errors, ["Input 1: enter a name.", "Input 1: choose the value to pass.", 'Input "budget": choose the value to pass.']);
  });

  it("trigger.inputs.<name> is a condition field; a trigger filter may use it only on the journey.started trigger", () => {
    const rule = { field: "trigger.inputs.tier", operator: "equals", value: "gold" };
    assert.deepEqual(validateNodeConfig("condition", rule, "strict").errors, []);
    assert.deepEqual(validateNodeConfig("trigger", { event: "journey.started", filters: [rule] }, "strict").errors, []);
    assert.deepEqual(validateNodeConfig("trigger", { event: "manual", filters: [rule] }, "strict").errors, ["Filter 1: inputs only exist when another journey starts this one."]);
  });
});

// ---------- Activation ----------

describe("activation", () => {
  const graph = (event: string, nodes: Array<Omit<SnapshotNode, "description">>): JourneySnapshot => {
    const all: SnapshotNode[] = [{ id: "t", type: "trigger", name: "Trigger", description: "", config: { event, filters: [] } }, ...nodes.map((node) => ({ ...node, description: "" }))];
    return { nodes: all, connections: all.slice(1).map((node, i) => ({ id: `c${i}`, sourceNodeId: all[i].id, targetNodeId: node.id, sourceHandle: null, targetHandle: null })) };
  };
  const startNode = (inputMappings: InputMapping[]) => ({ id: "s", type: "action" as const, name: "Start", config: { action: "start_journey", journeyId: randomUUID(), inputMappings } });
  const aiNode = { id: "ai", type: "ai" as const, name: "Score", config: { goal: "Score", instructions: "", agent: "default", outputSchema: [{ name: "score", type: "number", description: "" }] } };
  const messages = (snapshot: JourneySnapshot) => activationIssues(snapshot).map((issue) => issue.message);

  it("a valid mapping list activates", () => {
    assert.deepEqual(messages(graph("lead.status_changed", [aiNode, startNode([map("score", "steps.ai.output.score"), map("to", "trigger.to_status"), map("budget", "lead.budget")])])), []);
    assert.deepEqual(messages(graph("journey.started", [startNode([map("tier", "trigger.inputs.tier")])])), []);
  });

  it("a step output must come from a step that always runs before, and be a field it defines", () => {
    assert.deepEqual(messages(graph("manual", [startNode([map("score", "steps.ai.output.score")]), aiNode])), ['"Start": Input "score": "Score" doesn\'t run before this step on every path.']);
    assert.deepEqual(messages(graph("manual", [aiNode, startNode([map("x", "steps.ai.output.other")])])), ['"Start": Input "x": output field "other" isn\'t defined by "Score".']);
    assert.deepEqual(messages(graph("manual", [startNode([map("x", "steps.s.output.run_id")])])), ['"Start": Input "x": a step can\'t reference its own output.']);
    assert.deepEqual(messages(graph("manual", [startNode([map("x", "steps.gone.output.a")])])), ['"Start": Input "x": the referenced journey step no longer exists.']);
  });

  it("an event field must belong to the journey's trigger; journey inputs need the journey.started trigger", () => {
    assert.deepEqual(messages(graph("manual", [startNode([map("body", "trigger.body")])])), ['"Start": Input "body": "Message text" isn\'t part of this journey\'s trigger event.']);
    assert.deepEqual(messages(graph("manual", [startNode([map("tier", "trigger.inputs.tier")])])), [
      '"Start": Input "tier": inputs only exist when another journey starts this one ("Started by another journey" trigger).',
    ]);
    const condition = { id: "c", type: "condition" as const, name: "Check", config: { field: "trigger.inputs.tier", operator: "equals", value: "gold" } };
    assert.ok(messages(graph("manual", [condition])).includes('"Check": inputs only exist when another journey starts this one ("Started by another journey" trigger).'));
  });

  it("condition step-reference messages are unchanged", () => {
    const condition = { id: "c", type: "condition" as const, name: "Check", config: { field: "steps.c.output.result", operator: "equals", value: "x" } };
    assert.ok(messages(graph("manual", [condition])).includes('"Check": a condition can\'t reference its own output.'));
  });
});

// ---------- Propagation ----------

describe("propagation", () => {
  it("a mapped lead value arrives as exactly that input, next to unchanged lineage", async () => {
    const b = journey("B", "journey.started", [task()]);
    const a = journey("A", "manual", [start(b, [map("budget", "lead.budget")])]);

    await enroll(a);

    const runA = only(a);
    assert.deepEqual(only(b).triggerPayload, {
      origin: "journey",
      origin_run_id: runA.id,
      origin_journey_id: a,
      root_run_id: runA.id,
      causation_depth: 1,
      inputs: { budget: "500k" },
    });
    assert.equal(only(b).contactId, contact);
    assert.deepEqual(stepAt(runA, 0).output, { started: true, target_journey_id: b, run_id: only(b).id, causation_depth: 1 });
  });

  it("the child reads its input in a condition (trigger.inputs.<name>)", async () => {
    const b = conditional("B", { field: "trigger.inputs.budget", operator: "equals", value: "500k" });
    await enroll(journey("A", "manual", [start(b, [map("budget", "lead.budget")])]));
    assert.deepEqual(performed, ["B:yes"]);
  });

  it("the child's condition sees a different value when the parent passes one", async () => {
    store.contacts.get(contact)!.lead.budget = "200k";
    const b = conditional("B", { field: "trigger.inputs.budget", operator: "equals", value: "500k" });
    await enroll(journey("A", "manual", [start(b, [map("budget", "lead.budget")])]));
    assert.deepEqual(performed, ["B:no"]);
  });

  it("the child's AI step receives the inputs in its trigger data", async () => {
    const b = journey("B", "journey.started", [aiStep()]);
    await enroll(journey("A", "manual", [start(b, [map("budget", "lead.budget")])]));
    assert.equal(aiRequests.length, 1);
    assert.deepEqual(aiRequests[0].context.trigger.payload.inputs, { budget: "500k" });
  });

  it("multiple mappings arrive under their names with their types", async () => {
    const b = journey("B", "journey.started", [task()]);
    const a = journey("A", "manual", [
      start(b, [
        map("budget", "lead.budget"),
        map("score", "lead.qualification_score"),
        map("ready", "lead.ready_to_book"),
        map("stage", "opportunity.stage"),
        map("same_budget", "lead.budget"),
      ]),
    ]);
    await enroll(a);
    assert.deepEqual(only(b).triggerPayload.inputs, { budget: "500k", score: 72, ready: true, stage: "Qualified", same_budget: "500k" });
  });

  it("an event field of the parent's trigger can be passed", async () => {
    const b = journey("B", "journey.started", [task()]);
    const a = journey("A", "lead.status_changed", [start(b, [map("to", "trigger.to_status"), map("from", "trigger.from_status")])]);
    await dispatchJourneyEvent(deps, {
      tenantId: tenant, type: "lead.status_changed", sourceId: randomUUID(), contactId: contact, entityType: "contact", entityId: contact,
      payload: { from_status: "New", to_status: "Working", origin: "user" },
    });
    assert.equal(only(b).triggerPayload.origin_journey_id, a);
    assert.deepEqual(only(b).triggerPayload.inputs, { to: "Working", from: "New" });
  });

  it("values are read when the step runs, after earlier steps in the same pass changed the lead", async () => {
    const b = journey("B", "journey.started", [task()]);
    await enroll(journey("A", "manual", [setLead({ qualification_score: 90 }), start(b, [map("score", "lead.qualification_score")])]));
    assert.deepEqual(only(b).triggerPayload.inputs, { score: 90 });
  });

  it("a child can pass its own input on to a grandchild", async () => {
    const c = journey("C", "journey.started", [task()]);
    const b = journey("B", "journey.started", [start(c, [map("tier", "trigger.inputs.tier")])]);
    store.contacts.get(contact)!.lead.lead_temperature = "Hot";
    await enroll(journey("A", "manual", [start(b, [map("tier", "lead.lead_temperature")])]));
    assert.deepEqual(only(c).triggerPayload.inputs, { tier: "Hot" });
  });

  it("the child's trigger filters can use inputs, and still apply", async () => {
    const gold: ConditionRule = { field: "trigger.inputs.tier", operator: "equals", value: "gold" };
    const b = journey("B", "journey.started", [task()], { filters: [gold] });
    store.contacts.get(contact)!.lead.lead_temperature = "Hot";
    const a = journey("A", "manual", [start(b, [map("tier", "lead.lead_temperature")]), task("after")]);

    await enroll(a);

    assert.equal(runsOf(b).length, 0);
    assert.equal(stepAt(only(a), 0).output?.skipped_reason, "trigger_filters_not_matched");
    assert.deepEqual(performed, ["A:after"]);
  });
});

describe("step outputs", () => {
  it("only the selected output field crosses over, never the rest of the step", async () => {
    const b = journey("B", "journey.started", [task()]);
    const a = randomUUID();
    aiOutputs.set(`${a}-n0`, { score: 80, notes: "private reasoning", sales_ready: true });
    journey("A", "manual", [aiStep(), start(b, [map("score", stepRef(a, 0, "score"))])], { id: a });

    await enroll(a);

    const payload = only(b).triggerPayload;
    assert.deepEqual(payload.inputs, { score: 80 });
    assert.deepEqual(Object.keys(payload).sort(), [...LINEAGE_KEYS, "inputs"].sort());
    const serialized = JSON.stringify(only(b));
    for (const leaked of ["private reasoning", "sales_ready", "Because the lead said so."]) assert.ok(!serialized.includes(leaked), leaked);
  });

  it("a legacy name-derived step reference resolves too", async () => {
    const b = journey("B", "journey.started", [task()]);
    const a = randomUUID();
    aiOutputs.set(`${a}-n0`, { score: 55 });
    journey("A", "manual", [aiStep(), start(b, [map("score", "steps.step_0.output.score")])], { id: a });
    await enroll(a);
    assert.deepEqual(only(b).triggerPayload.inputs, { score: 55 });
  });

  it("the AI explanation is passed only when selected", async () => {
    const b = journey("B", "journey.started", [task()]);
    const a = randomUUID();
    journey("A", "manual", [aiStep(), start(b, [map("why", stepRef(a, 0, "ai_response"))])], { id: a });
    await enroll(a);
    assert.deepEqual(only(b).triggerPayload.inputs, { why: "Because the lead said so." });
  });
});

describe("missing values", () => {
  it("a missing source is passed as null under its name; nothing else fills it", async () => {
    const b = journey("B", "journey.started", [task()]);
    const a = randomUUID();
    aiOutputs.set(`${a}-n0`, { score: 80 });
    journey("A", "manual", [aiStep(), start(b, [map("timeline", "lead.timeline"), map("absent", stepRef(a, 0, "missing")), map("stage", "trigger.to_status")])], { id: a });

    await enroll(a);

    assert.deepEqual(only(b).triggerPayload.inputs, { timeline: null, absent: null, stage: null });
    assert.equal(only(b).status, "completed");
  });

  it("a child reading an input that wasn't passed sees it as empty", async () => {
    const b = conditional("B", { field: "trigger.inputs.nope", operator: "is_empty", value: null });
    await enroll(journey("A", "manual", [start(b, [map("budget", "lead.budget")])]));
    assert.deepEqual(performed, ["B:yes"]);
  });

  it("an empty input stays empty in the child (is_empty)", async () => {
    const b = conditional("B", { field: "trigger.inputs.timeline", operator: "is_empty", value: null });
    await enroll(journey("A", "manual", [start(b, [map("timeline", "lead.timeline")])]));
    assert.deepEqual(performed, ["B:yes"]);
  });
});

describe("no mappings", () => {
  it("the child payload is exactly the Stage 2 lineage, with no inputs key", async () => {
    const b = journey("B", "journey.started", [task()]);
    const a = journey("A", "manual", [setLead({ qualification_score: 99 }), start(b)]);
    await enroll(a);
    assert.deepEqual(Object.keys(only(b).triggerPayload).sort(), LINEAGE_KEYS);
    assert.equal(Object.hasOwn(only(b).triggerPayload, "inputs"), false);
  });

  it("an empty mapping list behaves the same", async () => {
    const b = journey("B", "journey.started", [task()]);
    await enroll(journey("A", "manual", [start(b, [])]));
    assert.deepEqual(Object.keys(only(b).triggerPayload).sort(), LINEAGE_KEYS);
  });
});

// ---------- Isolation and security ----------

describe("isolation", () => {
  it("values come only from the run's own workspace: a contact id from another workspace reads nothing", async () => {
    const other = randomUUID();
    const foreignContact = randomUUID();
    store.contacts.set(foreignContact, { tenantId: other, lead: { budget: "FOREIGN-SECRET", lead_status: "New" } });
    const b = journey("B", "journey.started", [task()]);
    const a = journey("A", "manual", [start(b, [map("budget", "lead.budget")])]);

    await enroll(a, foreignContact);

    const child = only(b);
    assert.equal(child.tenantId, tenant);
    assert.equal(child.contactId, foreignContact, "same contact id as the parent, never another");
    assert.deepEqual(child.triggerPayload.inputs, { budget: null });
    assert.ok(!JSON.stringify(runs()).includes("FOREIGN-SECRET"));
  });

  it("a journey in another workspace can't be started with inputs; no run anywhere gets them", async () => {
    const other = randomUUID();
    const foreign = journey("Foreign", "journey.started", [task()], { tenantId: other });
    const a = journey("A", "manual", [start(foreign, [map("budget", "lead.budget")]), task("after")]);

    await enroll(a);

    assert.equal(runsOf(foreign).length, 0);
    assert.equal(stepAt(only(a), 0).output?.skipped_reason, "target_not_found");
    assert.ok(runs().every((run) => !Object.hasOwn(run.triggerPayload, "inputs")));
    assert.deepEqual(performed, ["A:after"]);
  });

  it("the child is always the parent's contact", async () => {
    const second = randomUUID();
    store.contacts.set(second, { tenantId: tenant, lead: { budget: "900k", lead_status: "New" } });
    const b = journey("B", "journey.started", [task()]);
    const a = journey("A", "manual", [start(b, [map("budget", "lead.budget")])]);
    await enroll(a, second);
    assert.equal(only(b).contactId, second);
    assert.deepEqual(only(b).triggerPayload.inputs, { budget: "900k" });
  });

  it("a run that wasn't started by journey.started has no inputs, even if its payload has an inputs key", () => {
    const context = (event: string): ExecutionContext => ({ lead: null, opportunity: null, trigger: { event, payload: { inputs: { tier: "gold" } } }, steps: {} });
    assert.equal(resolveField(context("manual"), "trigger.inputs.tier"), undefined);
    assert.equal(resolveField(context("lead.status_changed"), "trigger.inputs.tier"), undefined);
    assert.equal(resolveField(context("journey.started"), "trigger.inputs.tier"), "gold");
    assert.equal(resolveField(context("journey.started"), "trigger.inputs.constructor"), undefined, "own keys only");
  });

  it("the child can't change the parent: the parent's recorded state is the same after the child ran", async () => {
    const b = journey("B", "journey.started", [waitDay, setLead({ qualification_score: 5 }), task()]);
    const a = journey("A", "manual", [start(b, [map("score", "lead.qualification_score")]), waitDay]);

    await enroll(a);

    const parent = only(a);
    assert.equal(parent.status, "waiting");
    assert.equal(only(b).status, "waiting");
    const before = structuredClone(store.runs.get(parent.id)!);
    await executeRun(deps, only(b).id);
    assert.equal(only(b).status, "completed");
    assert.deepEqual(store.runs.get(parent.id), before);
    assert.deepEqual(only(b).triggerPayload.inputs, { score: 72 }, "the value at start, not the child's later change");
  });
});

// ---------- Idempotency ----------

describe("idempotency", () => {
  it("repeating the start step after the parent-side value changed creates nothing and leaves the child's inputs alone", async () => {
    const b = journey("B", "journey.started", [task()]);
    const a = journey("A", "manual", [start(b, [map("budget", "lead.budget")])]);
    await enroll(a);
    const child = only(b);
    const original = structuredClone(child.triggerPayload);

    store.contacts.get(contact)!.lead.budget = "CHANGED";
    rewind(only(a), 0);
    await executeRun(deps, only(a).id);

    assert.equal(only(b).id, child.id);
    assert.deepEqual(only(b).triggerPayload, original);
    assert.equal(stepAt(only(a), 0).output?.duplicate, true);
    assert.deepEqual(performed, ["B:Follow up"]);
  });

  it("redelivering the event with different inputs returns the existing run, inputs unchanged", async () => {
    const b = journey("B", "journey.started", [task()]);
    const a = journey("A", "manual", [start(b, [map("budget", "lead.budget")])]);
    await enroll(a);
    const event: JourneyEvent = {
      tenantId: tenant, type: "journey.started", sourceId: `${only(a).id}:${a}-n0`, journeyId: b, contactId: contact, entityType: "contact", entityId: contact,
      payload: { origin: "journey", causation_depth: 0, inputs: { budget: "FORGED" } },
    };

    const outcomes = await dispatchJourneyEvent(deps, event);

    assert.deepEqual(outcomes.map((outcome) => outcome.result), ["duplicate"]);
    assert.deepEqual(only(b).triggerPayload.inputs, { budget: "500k" });
  });

  it("the run key doesn't contain input values", async () => {
    const b = journey("B", "journey.started", [task()]);
    const a = journey("A", "manual", [start(b, [map("budget", "lead.budget")])]);
    await enroll(a);
    assert.equal(store.runs.get(only(b).id)!.idempotencyKey, `journey.started:${only(a).id}:${a}-n0:${b}`);
  });

  it("an interrupted start step resumes without a second child or new inputs", async () => {
    const b = journey("B", "journey.started", [task()]);
    const a = journey("A", "manual", [start(b, [map("budget", "lead.budget")])]);
    await enroll(a);
    const runA = store.runs.get(only(a).id)!;
    const stepId = stepAt(runA, 0).id;
    store.steps.find((step) => step.id === stepId)!.status = "running";
    Object.assign(runA, { status: "running", currentNodeId: `${a}-n0`, lockedUntil: null, completedAt: null, resumeAt: new Date().toISOString(), context: { ...runA.context, inFlight: { nodeId: `${a}-n0`, stepId } } });
    store.contacts.get(contact)!.lead.budget = "CHANGED";

    await resumeDueRuns(deps);

    assert.equal(runsOf(b).length, 1);
    assert.deepEqual(only(b).triggerPayload.inputs, { budget: "500k" });
  });
});

// ---------- Retry ----------

describe("retry", () => {
  it("a failed child keeps its original inputs when retried, and still reads them", async () => {
    const c = journey("C", "journey.started", [task()]);
    const b = journey("B", "journey.started", [task(), start(c, [map("budget", "trigger.inputs.budget")])]);
    const a = journey("A", "manual", [start(b, [map("budget", "lead.budget")])]);
    failNextTask.add("B");

    await enroll(a);
    const child = only(b);
    assert.equal(child.status, "failed");
    const original = structuredClone(child.triggerPayload);
    store.contacts.get(contact)!.lead.budget = "CHANGED";

    await retry(child);

    assert.equal(only(b).status, "completed");
    assert.deepEqual(only(b).triggerPayload, original);
    assert.deepEqual(only(c).triggerPayload.inputs, { budget: "500k" }, "the retried child read its original input");
  });

  it("retrying a parent that failed after starting its child doesn't duplicate the child or change its inputs", async () => {
    const b = journey("B", "journey.started", [task()]);
    const a = journey("A", "manual", [start(b, [map("budget", "lead.budget")]), task()]);
    failNextTask.add("A");

    await enroll(a);
    assert.equal(only(a).status, "failed");
    const child = structuredClone(only(b));
    store.contacts.get(contact)!.lead.budget = "CHANGED";

    await retry(only(a));

    assert.equal(only(a).status, "completed");
    assert.equal(only(b).id, child.id);
    assert.deepEqual(only(b).triggerPayload, child.triggerPayload);
  });

  it("a parent that failed before its start step keeps the mapping: the retried step passes the values", async () => {
    const b = journey("B", "journey.started", [task()]);
    const a = journey("A", "manual", [task(), start(b, [map("budget", "lead.budget"), map("score", "lead.qualification_score")])]);
    failNextTask.add("A");

    await enroll(a);
    assert.equal(only(a).status, "failed");
    assert.equal(runsOf(b).length, 0);

    await retry(only(a));

    assert.equal(only(a).status, "completed");
    assert.deepEqual(only(b).triggerPayload.inputs, { budget: "500k", score: 72 });
  });
});

// ---------- Limits ----------

describe("limits at runtime", () => {
  it("a value that isn't text, a number, or yes/no passes nothing: the step is skipped and the parent continues", async () => {
    const b = journey("B", "journey.started", [task()]);
    const a = randomUUID();
    aiOutputs.set(`${a}-n0`, { details: { nested: "object" }, list: [1, 2] });
    journey("A", "manual", [aiStep(), start(b, [map("details", stepRef(a, 0, "details")), map("list", stepRef(a, 0, "list"))]), task("after")], { id: a });

    await enroll(a);

    assert.equal(runsOf(b).length, 0);
    assert.equal(only(a).status, "completed");
    assert.deepEqual(stepAt(only(a), 1).output, {
      started: false,
      target_journey_id: b,
      input_errors: ['Input "details": the value isn\'t text, a number, or yes/no.', 'Input "list": the value isn\'t text, a number, or yes/no.'],
      skipped_reason: "inputs_invalid",
    });
    assert.deepEqual(performed, ["A:after"]);
  });

  it(`inputs over ${MAX_INPUTS_BYTES} bytes pass nothing (inputs_too_large); values aren't recorded`, async () => {
    store.contacts.get(contact)!.lead.budget = "x".repeat(MAX_INPUTS_BYTES);
    const b = journey("B", "journey.started", [task()]);
    const a = journey("A", "manual", [start(b, [map("budget", "lead.budget")]), task("after")]);

    await enroll(a);

    assert.equal(runsOf(b).length, 0);
    const output = stepAt(only(a), 0).output!;
    assert.equal(output.skipped_reason, "inputs_too_large");
    assert.equal(output.max_inputs_bytes, MAX_INPUTS_BYTES);
    assert.ok((output.inputs_bytes as number) > MAX_INPUTS_BYTES);
    assert.ok(!JSON.stringify(store.steps).includes("x".repeat(100)));
    assert.deepEqual(performed, ["A:after"]);
  });

  it("the byte limit counts UTF-8, and a result at the limit passes", () => {
    const pad = (n: number) => journeyInputs([map("v", "s")], () => "é".repeat(n));
    const overhead = JSON.stringify({ v: "" }).length;
    const fits = Math.floor((MAX_INPUTS_BYTES - overhead) / 2);
    assert.equal(pad(fits).ok, true);
    assert.equal(pad(fits + 1).ok, false);
    assert.deepEqual(journeyInputs([map("n", "s")], () => Number.NaN), { ok: false, reason: "inputs_invalid", errors: ['Input "n": the value isn\'t text, a number, or yes/no.'] });
  });

  it("a malformed mapping list in a stored version (bypassing validation) starts nothing", async () => {
    const b = journey("B", "journey.started", [task()]);
    for (const inputMappings of [[map("Bad Name", "lead.budget")], [map("a", "context.steps")], "lead.budget", [map("a", "lead.budget"), map("a", "lead.email")]]) {
      const a = journey("A", "manual", [start(b, inputMappings), task("after")]);
      await enroll(a);
      assert.equal(runsOf(b).length, 0, JSON.stringify(inputMappings));
      assert.equal(stepAt(only(a), 0).output?.skipped_reason, "inputs_invalid");
      assert.ok(Array.isArray(stepAt(only(a), 0).output?.input_errors));
    }
  });
});

// ---------- Lineage and causation ----------

describe("lineage and the causation cap", () => {
  it("inputs never change lineage: A → B → C keep origin, root, and depth as in Stage 2", async () => {
    const c = journey("C", "journey.started", [task()]);
    const b = journey("B", "journey.started", [start(c, [map("tier", "trigger.inputs.tier")])]);
    const a = journey("A", "manual", [start(b, [map("tier", "lead.budget")])]);

    await enroll(a);

    const [runA, runB, runC] = [only(a), only(b), only(c)];
    const lineage = (run: MemoryRun) => Object.fromEntries(LINEAGE_KEYS.map((key) => [key, run.triggerPayload[key]]));
    assert.deepEqual(lineage(runB), { causation_depth: 1, origin: "journey", origin_journey_id: a, origin_run_id: runA.id, root_run_id: runA.id });
    assert.deepEqual(lineage(runC), { causation_depth: 2, origin: "journey", origin_journey_id: b, origin_run_id: runB.id, root_run_id: runA.id });
    assert.deepEqual([runA, runB, runC].map(runCausationDepth), [1, 2, 3]);
  });

  it("inputs can't bypass the cap: a depth-3 run's start step is depth-limited before inputs are read", async () => {
    const d = journey("D", "journey.started", [task()]);
    const c = journey("C", "journey.started", [start(d, [map("budget", "lead.budget")]), task("C done")]);
    const b = journey("B", "journey.started", [start(c, [map("budget", "lead.budget")])]);
    const a = journey("A", "manual", [start(b, [map("budget", "lead.budget")])]);

    await enroll(a);

    assert.equal(runsOf(d).length, 0);
    assert.deepEqual(stepAt(only(c), 0).output, { started: false, target_journey_id: d, causation_depth: 3, skipped_reason: "depth_limited" });
    assert.deepEqual(performed, ["C:C done"]);
  });

  it("forged inputs or causation keys on a parent payload don't lower depth", async () => {
    const t = journey("T", "journey.started", [task()]);
    const p = journey("P", "journey.started", [start(t, [map("x", "trigger.inputs.causation_depth")])]);
    const created = await store.createRun({
      tenantId: tenant, journeyId: p, journeyVersion: 1, contactId: contact, entityType: "contact", entityId: contact,
      currentNodeId: `${p}-t`, triggerEvent: "journey.started", triggerPayload: { causation_depth: 2, inputs: { causation_depth: 0 } },
      idempotencyKey: randomUUID(), resumeAt: new Date().toISOString(),
    });
    await executeRun(deps, created.run!.id);
    assert.equal(runsOf(t).length, 0);
    assert.equal(stepAt(only(p), 0).output?.skipped_reason, "depth_limited");
  });

  it("a mapped input named causation_depth stays inside inputs and doesn't change the child's depth", async () => {
    const b = journey("B", "journey.started", [task()]);
    store.contacts.get(contact)!.lead.qualification_score = 0;
    const a = journey("A", "manual", [start(b, [map("causation_depth", "lead.qualification_score"), map("root_run_id", "lead.budget")])]);
    await enroll(a);
    const payload = only(b).triggerPayload;
    assert.equal(payload.causation_depth, 1);
    assert.equal(payload.root_run_id, only(a).id);
    assert.deepEqual(payload.inputs, { causation_depth: 0, root_run_id: "500k" });
    assert.equal(runCausationDepth(only(b)), 2);
  });

  it("mixed chain: inputs don't travel through a status change; root and depth are as in Stage 2; the cap holds", async () => {
    const d = journey("D", "journey.started", [task()]);
    const c = journey("C", "lead.status_changed", [start(d, [map("budget", "lead.budget")])], { filters: [{ field: "trigger.to_status", operator: "equals", value: "Qualified" }] });
    const b = journey("B", "journey.started", [setLead({ lead_status: "Qualified" })]);
    const a = journey("A", "manual", [start(b, [map("budget", "lead.budget")])]);

    await enroll(a);
    await drainOutbox();

    const [runA, runB, runC] = [only(a), only(b), only(c)];
    assert.deepEqual(runB.triggerPayload.inputs, { budget: "500k" });
    assert.equal(Object.hasOwn(runC.triggerPayload, "inputs"), false, "a status change carries no inputs");
    assert.equal(runC.triggerPayload.root_run_id, runA.id);
    assert.equal(runC.triggerPayload.origin_run_id, runB.id);
    assert.equal(runCausationDepth(runC), 3);
    assert.equal(runsOf(d).length, 0);
    assert.equal(stepAt(runC, 0).output?.skipped_reason, "depth_limited");
  });

  it("mixed chain: a run started by a status change passes inputs to its child at the next depth", async () => {
    const c = journey("C", "journey.started", [task()]);
    const b = journey("B", "lead.status_changed", [start(c, [map("to", "trigger.to_status")])], { filters: [{ field: "trigger.to_status", operator: "equals", value: "Working" }] });
    const a = journey("A", "manual", [setLead({ lead_status: "Working" })]);

    await enroll(a);
    await drainOutbox();

    const runC = only(c);
    assert.deepEqual(runC.triggerPayload.inputs, { to: "Working" });
    assert.equal(runC.triggerPayload.root_run_id, only(a).id);
    assert.equal(runC.triggerPayload.causation_depth, 2);
    assert.equal(runC.triggerPayload.origin_journey_id, b);
  });
});

describe("still skipped before inputs are read", () => {
  it("self-start, inactive, and already-active targets are skipped as in Stage 2, with no inputs anywhere", async () => {
    const self = randomUUID();
    journey("Self", "manual", [start(self, [map("budget", "lead.budget")])], { id: self });
    await enroll(self);
    assert.equal(stepAt(only(self), 0).output?.skipped_reason, "self_start");

    const paused = journey("Paused", "journey.started", [task()]);
    store.setStatus(paused, "paused");
    const p = journey("P", "manual", [start(paused, [map("budget", "lead.budget")])]);
    await enroll(p);
    assert.equal(stepAt(only(p), 0).output?.skipped_reason, "target_inactive");

    const busy = journey("Busy", "journey.started", [waitDay]);
    const q = journey("Q", "manual", [start(busy, [map("budget", "lead.budget")])]);
    await enroll(q);
    const first = structuredClone(only(busy));
    store.contacts.get(contact)!.lead.budget = "CHANGED";
    await enroll(q);
    assert.equal(runsOf(busy).length, 1);
    assert.deepEqual(only(busy).triggerPayload, first.triggerPayload);
    assert.equal(stepAt(runsOf(q)[1], 0).output?.skipped_reason, "already_active");
  });
});
