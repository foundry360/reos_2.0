import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";
import type { JourneyAIExecutor, JourneyAIRequest } from "./ai.ts";
import {
  EMPTY_STEP_REFERENCE,
  nodeReferenceKey,
  STEP_FIELD_DRAFT,
  stepReferenceDraft,
  stepReferenceField,
  updateStepReferenceDraft,
} from "./contracts.ts";
import { dispatchJourneyEvent, resumeDueRuns, type ActionExecutor, type EngineDeps, type JourneyEvent } from "./engine.ts";
import {
  activationIssues,
  guaranteedPredecessors,
  knownOutputFields,
  referenceableSteps,
  resolveStepReference,
  stepKeys,
  type JourneySnapshot,
  type SnapshotNode,
} from "./graph.ts";
import { MemoryJourneyStore } from "./memory-store.ts";

const TENANT = "tenant-a";
const LEAD = "contact-1";

const ID = {
  t: "00000000-0000-4000-8000-000000000001",
  t2: "00000000-0000-4000-8000-000000000002",
  ai: "00000000-0000-4000-8000-0000000000a1",
  ai2: "00000000-0000-4000-8000-0000000000a2",
  act: "00000000-0000-4000-8000-0000000000b1",
  act2: "00000000-0000-4000-8000-0000000000b2",
  wait: "00000000-0000-4000-8000-0000000000c1",
  c: "00000000-0000-4000-8000-0000000000d1",
  c2: "00000000-0000-4000-8000-0000000000d2",
  yes: "00000000-0000-4000-8000-0000000000e1",
  no: "00000000-0000-4000-8000-0000000000e2",
  end: "00000000-0000-4000-8000-0000000000e3",
};

const SCHEMA = [
  { name: "sales_ready", type: "boolean", description: "" },
  { name: "score", type: "number", description: "" },
];

function trigger(id = ID.t): SnapshotNode {
  return { id, type: "trigger", name: "New lead", description: "", config: { event: "lead.created", filters: [] } };
}
function ai(id: string, name: string, outputSchema?: unknown[]): SnapshotNode {
  const config: Record<string, unknown> = { goal: "Qualify", instructions: "", agent: "default" };
  if (outputSchema) config.outputSchema = outputSchema;
  return { id, type: "ai", name, description: "", config };
}
function sms(id: string, name = "Text"): SnapshotNode {
  return { id, type: "action", name, description: "", config: { action: "send_sms", body: "Hi" } };
}
function wait(id = ID.wait): SnapshotNode {
  return { id, type: "action", name: "Wait", description: "", config: { action: "wait", duration: 1, unit: "days" } };
}
function condition(id: string, field: string, operator = "equals", value: unknown = true): SnapshotNode {
  return { id, type: "condition", name: id === ID.c2 ? "Second check" : "Check", description: "", config: { field, operator, value } };
}
function link(source: string, target: string, sourceHandle: string | null = null) {
  return { id: `${source}->${target}`, sourceNodeId: source, targetNodeId: target, sourceHandle, targetHandle: null };
}
function ref(nodeId: string, field: string) {
  return `steps.${nodeReferenceKey(nodeId)}.output.${field}`;
}
function referenceIssues(graph: JourneySnapshot): string[] {
  return activationIssues(graph)
    .filter((issue) => issue.nodeId === ID.c || issue.nodeId === ID.c2)
    .map((issue) => issue.message);
}

/** Trigger → AI → Condition → yes / no */
function linear(field: string, aiNode = ai(ID.ai, "Qualify Lead", SCHEMA)): JourneySnapshot {
  return {
    nodes: [trigger(), aiNode, condition(ID.c, field), sms(ID.yes, "Yes"), sms(ID.no, "No")],
    connections: [link(ID.t, ID.ai), link(ID.ai, ID.c), link(ID.c, ID.yes, "yes"), link(ID.c, ID.no, "no")],
  };
}

describe("building a reference in the editor", () => {
  const key = nodeReferenceKey(ID.ai);

  it("step first, then field, produces a full reference", () => {
    let draft = updateStepReferenceDraft(EMPTY_STEP_REFERENCE, { key });
    assert.equal(stepReferenceField(draft), STEP_FIELD_DRAFT);
    assert.equal(draft.key, key, "the chosen step is kept while the field is empty");
    draft = updateStepReferenceDraft(draft, { field: "sales_ready" });
    assert.equal(stepReferenceField(draft), `steps.${key}.output.sales_ready`);
  });

  it("field first, then step, also works", () => {
    let draft = updateStepReferenceDraft(EMPTY_STEP_REFERENCE, { field: "sales_ready" });
    assert.equal(draft.field, "sales_ready", "the typed field is kept while no step is chosen");
    draft = updateStepReferenceDraft(draft, { key });
    assert.equal(stepReferenceField(draft), `steps.${key}.output.sales_ready`);
  });

  it("clearing one half keeps the other", () => {
    const full = { key, field: "score" };
    const cleared = updateStepReferenceDraft(full, { field: "" });
    assert.deepEqual(cleared, { key, field: "" });
    assert.equal(stepReferenceField(cleared), STEP_FIELD_DRAFT);
  });

  it("round-trips a stored reference", () => {
    assert.deepEqual(stepReferenceDraft(`steps.${key}.output.score`), { key, field: "score" });
    assert.equal(stepReferenceDraft("lead.lead_status"), null);
    assert.equal(stepReferenceDraft(STEP_FIELD_DRAFT), null);
  });

  it("sanitizes typed field names like before", () => {
    assert.equal(updateStepReferenceDraft(EMPTY_STEP_REFERENCE, { field: "Sales Ready!" }).field, "salesready");
  });

  it("choosing a structured step drops a field it doesn't define", () => {
    const draft = updateStepReferenceDraft({ key: "", field: "budget" }, { key }, ["sales_ready", "ai_response"]);
    assert.deepEqual(draft, { key, field: "" });
    const kept = updateStepReferenceDraft({ key: "", field: "sales_ready" }, { key }, ["sales_ready", "ai_response"]);
    assert.equal(kept.field, "sales_ready");
  });
});

describe("guaranteed predecessors", () => {
  it("Trigger → AI → Condition: AI runs first", () => {
    const graph = linear(ref(ID.ai, "sales_ready"));
    assert.deepEqual([...guaranteedPredecessors(graph, ID.c)].sort(), [ID.t, ID.ai].sort());
  });

  it("a sibling branch off the trigger doesn't run first", () => {
    // Trigger → Condition, Trigger → AI
    const graph: JourneySnapshot = {
      nodes: [trigger(), condition(ID.c, ""), ai(ID.ai, "AI")],
      connections: [link(ID.t, ID.c), link(ID.t, ID.ai)],
    };
    assert.equal(guaranteedPredecessors(graph, ID.c).has(ID.ai), false);
  });

  it("an ancestor that only some triggers pass through doesn't run first", () => {
    const graph: JourneySnapshot = {
      nodes: [trigger(), trigger(ID.t2), ai(ID.ai, "AI"), condition(ID.c, "")],
      connections: [link(ID.t, ID.ai), link(ID.ai, ID.c), link(ID.t2, ID.c)],
    };
    assert.equal(guaranteedPredecessors(graph, ID.c).has(ID.ai), false);
  });

  it("a node on both sides of a branch that merges runs first", () => {
    // Trigger → C1 → (yes) A1 → AI → C2, (no) A2 → AI
    const graph: JourneySnapshot = {
      nodes: [trigger(), condition(ID.c, ""), sms(ID.act), sms(ID.act2), ai(ID.ai, "AI"), condition(ID.c2, "")],
      connections: [
        link(ID.t, ID.c),
        link(ID.c, ID.act, "yes"),
        link(ID.c, ID.act2, "no"),
        link(ID.act, ID.ai),
        link(ID.act2, ID.ai),
        link(ID.ai, ID.c2),
      ],
    };
    const before = guaranteedPredecessors(graph, ID.c2);
    assert.ok(before.has(ID.ai));
    assert.ok(before.has(ID.c));
    assert.equal(before.has(ID.act), false);
    assert.equal(before.has(ID.act2), false);
  });

  it("an unreachable target has no guaranteed predecessors", () => {
    const graph: JourneySnapshot = { nodes: [trigger(), ai(ID.ai, "AI"), condition(ID.c, "")], connections: [link(ID.t, ID.ai)] };
    assert.equal(guaranteedPredecessors(graph, ID.c).size, 0);
  });

  it("the picker offers only AI and non-wait action steps that run first", () => {
    // Trigger → AI → Wait → Action → C → (yes) later AI
    const graph: JourneySnapshot = {
      nodes: [trigger(), ai(ID.ai, "AI"), wait(), sms(ID.act), condition(ID.c, ""), ai(ID.ai2, "Later")],
      connections: [link(ID.t, ID.ai), link(ID.ai, ID.wait), link(ID.wait, ID.act), link(ID.act, ID.c), link(ID.c, ID.ai2, "yes")],
    };
    assert.deepEqual(
      referenceableSteps(graph, ID.c).map((node) => node.id),
      [ID.ai, ID.act],
    );
  });

  it("known output fields come from the AI schema plus ai_response", () => {
    assert.deepEqual(knownOutputFields(ai(ID.ai, "AI", SCHEMA)), ["sales_ready", "score", "ai_response"]);
    assert.equal(knownOutputFields(ai(ID.ai, "AI")), null, "freeform AI fields are typed");
    assert.equal(knownOutputFields(sms(ID.act)), null, "action outputs aren't declared");
  });
});

describe("activation validation of step references", () => {
  it("accepts a valid node-id reference", () => {
    assert.deepEqual(activationIssues(linear(ref(ID.ai, "sales_ready"))), []);
  });

  it("accepts ai_response on a structured AI step", () => {
    assert.deepEqual(activationIssues(linear(ref(ID.ai, "ai_response"))), []);
  });

  it("accepts any field on a freeform AI step", () => {
    assert.deepEqual(activationIssues(linear(ref(ID.ai, "anything_the_model_says"), ai(ID.ai, "Qualify Lead"))), []);
  });

  it("blocks a field the structured AI step doesn't define", () => {
    assert.deepEqual(referenceIssues(linear(ref(ID.ai, "budget"))), [
      `"Check": output field "budget" isn't defined by "Qualify Lead".`,
    ]);
  });

  it("blocks a reference to a deleted step", () => {
    const graph = linear(ref(ID.ai2, "sales_ready"));
    assert.deepEqual(referenceIssues(graph), [`"Check": the referenced journey step no longer exists.`]);
  });

  it("doesn't fall back to another node with the same name after a delete", () => {
    // The referenced node is gone; a different node now carries its old name.
    const graph = linear(ref(ID.ai2, "sales_ready"), ai(ID.ai, "Qualify Lead", SCHEMA));
    assert.deepEqual(referenceIssues(graph), [`"Check": the referenced journey step no longer exists.`]);
  });

  it("blocks a downstream reference", () => {
    const graph = linear(ref(ID.yes, "message_id"));
    assert.deepEqual(referenceIssues(graph), [`"Check": "Yes" doesn't run before this condition on every path.`]);
  });

  it("blocks a reference to the opposite branch", () => {
    // Trigger → C → (yes) AI → C2, (no) → C2
    const graph: JourneySnapshot = {
      nodes: [
        trigger(),
        condition(ID.c, "lead.lead_status", "equals", "New"),
        ai(ID.ai, "Qualify Lead", SCHEMA),
        condition(ID.c2, ref(ID.ai, "sales_ready")),
        sms(ID.end, "End"),
      ],
      connections: [link(ID.t, ID.c), link(ID.c, ID.ai, "yes"), link(ID.c, ID.c2, "no"), link(ID.ai, ID.c2), link(ID.c2, ID.end, "yes")],
    };
    assert.deepEqual(referenceIssues(graph), [`"Second check": "Qualify Lead" doesn't run before this condition on every path.`]);
  });

  it("accepts a step both branches run before merging", () => {
    const graph: JourneySnapshot = {
      nodes: [
        trigger(),
        ai(ID.ai, "Qualify Lead", SCHEMA),
        condition(ID.c, "lead.lead_status", "equals", "New"),
        sms(ID.act, "A"),
        sms(ID.act2, "B"),
        condition(ID.c2, ref(ID.ai, "score"), "greater_than", 50),
        sms(ID.end, "End"),
      ],
      connections: [
        link(ID.t, ID.ai),
        link(ID.ai, ID.c),
        link(ID.c, ID.act, "yes"),
        link(ID.c, ID.act2, "no"),
        link(ID.act, ID.c2),
        link(ID.act2, ID.c2),
        link(ID.c2, ID.end, "yes"),
      ],
    };
    assert.deepEqual(activationIssues(graph), []);
    const oneSide = structuredClone(graph);
    oneSide.nodes[5].config.field = ref(ID.act, "message_id");
    assert.deepEqual(referenceIssues(oneSide), [`"Second check": "A" doesn't run before this condition on every path.`]);
  });

  it("blocks a condition referencing itself", () => {
    const graph = linear(ref(ID.c, "result"));
    assert.deepEqual(referenceIssues(graph), [`"Check": a condition can't reference its own output.`]);
  });

  it("blocks an unreachable step", () => {
    const graph = linear(ref(ID.ai2, "x"));
    graph.nodes.push(ai(ID.ai2, "Floating"));
    assert.ok(referenceIssues(graph).includes(`"Check": "Floating" doesn't run before this condition on every path.`));
  });

  it("blocks trigger, condition, and wait sources", () => {
    const toTrigger = linear(ref(ID.t, "event"));
    assert.deepEqual(referenceIssues(toTrigger), [
      `"Check": "New lead" isn't a step that produces output a condition can use.`,
    ]);

    const withWait: JourneySnapshot = {
      nodes: [trigger(), wait(), condition(ID.c, ref(ID.wait, "resumed_at"), "is_not_empty", null), sms(ID.yes)],
      connections: [link(ID.t, ID.wait), link(ID.wait, ID.c), link(ID.c, ID.yes, "yes")],
    };
    assert.deepEqual(referenceIssues(withWait), [`"Check": "Wait" isn't a step that produces output a condition can use.`]);

    const toCondition: JourneySnapshot = {
      nodes: [trigger(), condition(ID.c2, "lead.lead_status", "equals", "New"), condition(ID.c, ref(ID.c2, "result")), sms(ID.yes)],
      connections: [link(ID.t, ID.c2), link(ID.c2, ID.c, "yes"), link(ID.c, ID.yes, "yes")],
    };
    assert.deepEqual(referenceIssues(toCondition), [
      `"Check": "Second check" isn't a step that produces output a condition can use.`,
    ]);
  });

  it("validates legacy name-based references the same way", () => {
    assert.deepEqual(activationIssues(linear("steps.qualify_lead.output.sales_ready")), []);
    assert.deepEqual(referenceIssues(linear("steps.qualify_prospect.output.sales_ready")), [
      `"Check": the referenced journey step no longer exists.`,
    ]);
  });
});

describe("resolving references at runtime", () => {
  it("maps a node-id key to the snapshot's step key", () => {
    const graph = linear(ref(ID.ai, "sales_ready"));
    const keys = stepKeys(graph.nodes);
    const rule = { field: ref(ID.ai, "sales_ready"), operator: "equals" as const, value: true };
    assert.equal(resolveStepReference(rule, graph.nodes, keys).field, "steps.qualify_lead.output.sales_ready");
  });

  it("leaves legacy keys and ids missing from the snapshot unchanged", () => {
    const graph = linear("");
    const keys = stepKeys(graph.nodes);
    const legacy = { field: "steps.qualify_lead.output.sales_ready", operator: "equals" as const, value: true };
    assert.equal(resolveStepReference(legacy, graph.nodes, keys), legacy);
    const unknown = { field: ref(ID.ai2, "sales_ready"), operator: "equals" as const, value: true };
    assert.equal(resolveStepReference(unknown, graph.nodes, keys), unknown);
  });
});

// ---------- End-to-end through the engine ----------

class RecordingActions implements ActionExecutor {
  names: string[] = [];
  async execute(action: Parameters<ActionExecutor["execute"]>[0]) {
    this.names.push(action.action === "send_sms" ? action.body : action.action);
    return { status: "completed" as const, output: { ok: true } };
  }
}

/** Answers per AI node id so tests can tell same-named steps apart. */
class PerNodeAI implements JourneyAIExecutor {
  outputs = new Map<string, Record<string, unknown>>();
  async execute(request: JourneyAIRequest) {
    return { success: true as const, output: this.outputs.get(request.nodeId) ?? {}, text: "" };
  }
}

function leadEvent(): JourneyEvent {
  return { tenantId: TENANT, type: "lead.created", sourceId: LEAD, contactId: LEAD, entityType: "contact", entityId: LEAD, payload: {} };
}

function smsNode(id: string, body: string): SnapshotNode {
  return { id, type: "action", name: body, description: "", config: { action: "send_sms", body } };
}

/** Trigger → A → B → Condition(field) → yes / no; A and B can share a name. */
function twoAI(field: string, nameA = "Qualify Lead", nameB = "Qualify Lead"): JourneySnapshot {
  return {
    nodes: [
      trigger(),
      ai(ID.ai, nameA, SCHEMA),
      ai(ID.ai2, nameB, SCHEMA),
      condition(ID.c, field),
      smsNode(ID.yes, "yes"),
      smsNode(ID.no, "no"),
    ],
    connections: [link(ID.t, ID.ai), link(ID.ai, ID.ai2), link(ID.ai2, ID.c), link(ID.c, ID.yes, "yes"), link(ID.c, ID.no, "no")],
  };
}

describe("engine: node-id references", () => {
  let store: MemoryJourneyStore;
  let actions: RecordingActions;
  let aiExec: PerNodeAI;
  let clock: Date;
  let deps: EngineDeps;

  beforeEach(() => {
    store = new MemoryJourneyStore();
    actions = new RecordingActions();
    aiExec = new PerNodeAI();
    aiExec.outputs.set(ID.ai, { sales_ready: true, score: 90 });
    aiExec.outputs.set(ID.ai2, { sales_ready: false, score: 10 });
    clock = new Date("2026-10-01T12:00:00Z");
    deps = { store, actions, ai: aiExec, now: () => new Date(clock) };
    store.contacts.set(LEAD, { tenantId: TENANT, lead: { first_name: "Ana" } });
  });

  async function branchTaken(snapshot: JourneySnapshot): Promise<string[]> {
    store.saveJourney(TENANT, "j1", snapshot);
    const [outcome] = await dispatchJourneyEvent(deps, leadEvent());
    assert.equal(outcome.execution?.status, "completed");
    return actions.names;
  }

  it("resolves the referenced node's output", async () => {
    assert.deepEqual(await branchTaken(twoAI(ref(ID.ai, "sales_ready"), "Qualify Lead", "Score Lead")), ["yes"]);
  });

  it("keeps working after the referenced node is renamed", async () => {
    assert.deepEqual(await branchTaken(twoAI(ref(ID.ai, "sales_ready"), "Qualify Prospect", "Score Lead")), ["yes"]);
  });

  it("stays on the referenced node when two steps share a name", async () => {
    assert.deepEqual(await branchTaken(twoAI(ref(ID.ai, "sales_ready"))), ["yes"]);
    actions.names = [];
    store = new MemoryJourneyStore();
    store.contacts.set(LEAD, { tenantId: TENANT, lead: {} });
    deps.store = store;
    assert.deepEqual(await branchTaken(twoAI(ref(ID.ai2, "sales_ready"))), ["no"]);
  });

  it("stays on the referenced node when nodes are reordered", async () => {
    const snapshot = twoAI(ref(ID.ai, "sales_ready"));
    snapshot.nodes = [snapshot.nodes[2], snapshot.nodes[0], snapshot.nodes[5], snapshot.nodes[1], snapshot.nodes[3], snapshot.nodes[4]];
    const keys = stepKeys(snapshot.nodes);
    assert.equal(keys.get(ID.ai2), "qualify_lead", "the name-derived keys did swap");
    assert.deepEqual(await branchTaken(snapshot), ["yes"]);
  });

  it("legacy name-based references still resolve", async () => {
    assert.deepEqual(await branchTaken(twoAI("steps.qualify_lead.output.sales_ready", "Qualify Lead", "Score Lead")), ["yes"]);
  });

  it("legacy references keep their old behaviour after a rename", async () => {
    // Unchanged from before node-id keys: the old name no longer matches, so the value is empty.
    assert.deepEqual(
      await branchTaken(twoAI("steps.qualify_lead.output.sales_ready", "Qualify Prospect", "Score Lead")),
      ["no"],
    );
  });

  it("running versions keep their reference; new runs use the new version", async () => {
    // Trigger → AI → Wait → Condition → yes / no
    const v1: JourneySnapshot = {
      nodes: [
        trigger(),
        ai(ID.ai, "Qualify Lead", SCHEMA),
        wait(),
        condition(ID.c, ref(ID.ai, "sales_ready")),
        smsNode(ID.yes, "yes"),
        smsNode(ID.no, "no"),
      ],
      connections: [link(ID.t, ID.ai), link(ID.ai, ID.wait), link(ID.wait, ID.c), link(ID.c, ID.yes, "yes"), link(ID.c, ID.no, "no")],
    };
    store.saveJourney(TENANT, "j1", v1);
    const [first] = await dispatchJourneyEvent(deps, leadEvent());
    assert.equal(first.execution?.status, "waiting");

    const v2 = structuredClone(v1);
    v2.nodes[1].name = "Renamed";
    v2.nodes[3].config = { field: ref(ID.ai, "score"), operator: "greater_than", value: 95 };
    assert.equal(store.saveJourney(TENANT, "j1", v2), 2);

    clock = new Date(clock.getTime() + 2 * 24 * 60 * 60_000);
    await resumeDueRuns(deps);
    assert.equal(store.runs.get(first.runId!)!.journeyVersion, 1);
    assert.deepEqual(actions.names, ["yes"], "the pinned v1 condition (sales_ready = true) still applied");

    store.contacts.set("contact-2", { tenantId: TENANT, lead: {} });
    const [second] = await dispatchJourneyEvent(deps, { ...leadEvent(), sourceId: "contact-2", contactId: "contact-2", entityId: "contact-2" });
    assert.equal(store.runs.get(second.runId!)!.journeyVersion, 2);
    clock = new Date(clock.getTime() + 2 * 24 * 60 * 60_000);
    await resumeDueRuns(deps);
    assert.deepEqual(actions.names, ["yes", "no"], "the new run used v2 (score 90 is not > 95)");
  });
});
