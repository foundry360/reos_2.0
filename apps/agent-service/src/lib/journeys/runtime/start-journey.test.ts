/**
 * Start journey (start_journey action → journey.started trigger). Real engine,
 * dispatcher, and memory store; a status change made by a run goes through the
 * real outbox dispatcher (dispatchLeadStatusEvents) over an in-memory outbox, so
 * mixed status-change / Start journey chains share one depth and lineage.
 */

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { beforeEach, describe, it } from "node:test";
import type { JourneyStatus } from "../journey-types.ts";
import type { JourneyAIExecutor } from "./ai.ts";
import { validateNodeConfig, type ConditionRule } from "./contracts.ts";
import {
  dispatchJourneyEvent,
  executeRun,
  idempotencyKey,
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
/** "<journey>:<action>" for every non-engine action, in execution order. */
let performed: string[];
/** Journey names whose next Create task fails (once each). */
let failNextTask: Set<string>;
/** Status changes made by runs, waiting for the outbox dispatcher. */
let pending: LeadStatusEventRow[];

const ai: JourneyAIExecutor = { execute: async () => ({ success: true, output: {}, text: "" }) };

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
  pending = [];
  store.contacts.set(contact, { tenantId: tenant, lead: { lead_status: "New", record_type: "lead" } });

  const actions: ActionExecutor = {
    async execute(action, input) {
      const journeyName = names.get(input.nodeId.split(":")[0]) ?? "?";
      if (action.action === "create_task" && failNextTask.delete(journeyName)) {
        throw new JourneyStepError("Task service rejected the task.", "config");
      }
      if (action.action === "update_lead" && typeof action.fields.lead_status === "string" && input.contactId) {
        const lead = store.contacts.get(input.contactId)!.lead;
        const from = lead.lead_status as string;
        lead.lead_status = action.fields.lead_status;
        pending.push({
          id: randomUUID(),
          tenant_id: input.tenantId,
          contact_id: input.contactId,
          from_status: from,
          to_status: action.fields.lead_status,
          origin: "journey",
          actor_user_id: null,
          origin_run_id: input.runId,
          converted: false,
          changed_at: new Date().toISOString(),
          created_at: new Date().toISOString(),
          attempt_count: 1,
          claim_token: randomUUID(),
        });
      }
      performed.push(`${journeyName}:${action.action}`);
      return { status: "completed", output: {} };
    },
  };
  deps = { store, actions, ai };
});

type Step = Record<string, unknown>;
const task: Step = { action: "create_task", title: "Follow up", notes: "", dueInDays: 1 };
const start = (journeyId: string): Step => ({ action: "start_journey", journeyId });
const setStatus = (status: string): Step => ({ action: "update_lead", fields: { lead_status: status } });
const waitDay: Step = { action: "wait", duration: 1, unit: "days" };

/** Trigger → steps in order. Node ids are `<journey id>:<n>`; the trigger is `<journey id>:t`. */
function journey(
  name: string,
  event: string,
  steps: Step[],
  { filters = [], tenantId = tenant, status = "active" as JourneyStatus, id = randomUUID() } = {},
) {
  names.set(id, name);
  const nodes: SnapshotNode[] = [
    { id: `${id}:t`, type: "trigger", name: "Trigger", description: "", config: { event, filters } },
    ...steps.map((config, index): SnapshotNode => ({ id: `${id}:${index}`, type: "action", name: `Step ${index}`, description: "", config })),
  ];
  const snapshot: JourneySnapshot = {
    nodes,
    connections: nodes.slice(1).map((node, index) => ({
      id: `${id}:c${index}`,
      sourceNodeId: nodes[index].id,
      targetNodeId: node.id,
      sourceHandle: null,
      targetHandle: null,
    })),
  };
  store.saveJourney(tenantId, id, snapshot, status);
  return id;
}

/** journey.started trigger → Condition → yes steps / no steps. */
function conditional(name: string, condition: Record<string, unknown>, yes: Step[], no: Step[]) {
  const id = randomUUID();
  names.set(id, name);
  const toNodes = (prefix: string, steps: Step[]) =>
    steps.map((config, index): SnapshotNode => ({ id: `${id}:${prefix}${index}`, type: "action", name: `${prefix}${index}`, description: "", config }));
  const yesNodes = toNodes("y", yes);
  const noNodes = toNodes("n", no);
  const link = (source: string, target: string, sourceHandle: string | null = null) => ({
    id: `${source}->${target}`,
    sourceNodeId: source,
    targetNodeId: target,
    sourceHandle,
    targetHandle: null,
  });
  const path = (nodes: SnapshotNode[], handle: string) =>
    nodes.map((node, index) => link(index === 0 ? `${id}:c` : nodes[index - 1].id, node.id, index === 0 ? handle : null));
  store.saveJourney(tenant, id, {
    nodes: [
      { id: `${id}:t`, type: "trigger", name: "Trigger", description: "", config: { event: "journey.started", filters: [] } },
      { id: `${id}:c`, type: "condition", name: "Check", description: "", config: condition },
      ...yesNodes,
      ...noNodes,
    ],
    connections: [link(`${id}:t`, `${id}:c`), ...path(yesNodes, "yes"), ...path(noNodes, "no")],
  });
  return id;
}

/** A team member enrolls the lead by hand (a fresh manual event each time). */
async function enroll(journeyId: string, contactId: string | null = contact) {
  return dispatchJourneyEvent(deps, {
    tenantId: tenant,
    type: "manual",
    journeyId,
    sourceId: randomUUID(),
    contactId,
    entityType: "contact",
    entityId: contactId,
    payload: { enrolled_by: "user" },
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
/** The step recorded for node `<journey>:<index>` of a run (latest attempt). */
const stepAt = (run: MemoryRun, index: number | string) => store.stepsFor(run.id).filter((step) => step.nodeId === `${run.journeyId}:${index}`).at(-1)!;
const lineage = (run: MemoryRun) => {
  const { origin, origin_run_id, origin_journey_id, root_run_id, causation_depth } = run.triggerPayload;
  return { origin, origin_run_id, origin_journey_id, root_run_id, causation_depth };
};

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

/** Puts a finished run back at node `<journey>:<index>` so that step executes again (a repeated or racing execution). */
function rewind(run: MemoryRun, index: number) {
  const live = store.runs.get(run.id)!;
  Object.assign(live, { status: "running", currentNodeId: `${run.journeyId}:${index}`, lockedUntil: null, completedAt: null, resumeAt: new Date().toISOString() });
}

describe("contract", () => {
  it("start_journey needs a journey id; strict mode rejects a missing or malformed one", () => {
    const id = randomUUID();
    assert.deepEqual(validateNodeConfig("action", { action: "start_journey", journeyId: id, extra: 1 }, "strict"), {
      config: { action: "start_journey", journeyId: id },
      errors: [],
    });
    for (const journeyId of [undefined, "", "not-a-uuid", 7]) {
      const result = validateNodeConfig("action", { action: "start_journey", journeyId }, "strict");
      assert.deepEqual(result.config, { action: "start_journey", journeyId: "" });
      assert.deepEqual(result.errors, ["Choose the journey to start."]);
    }
    assert.deepEqual(validateNodeConfig("action", { action: "start_journey" }, "draft").errors, []);
  });

  it("journey.started is a selectable trigger", () => {
    assert.deepEqual(validateNodeConfig("trigger", { event: "journey.started", filters: [] }, "strict").errors, []);
  });

  it("the run key is journey.started:<parent run>:<node>:<target>, without the version", () => {
    assert.equal(idempotencyKey({ type: "journey.started", sourceId: "run-1:node-1" }, "target-1", 7), "journey.started:run-1:node-1:target-1");
  });
});

describe("basic start", () => {
  it("A starts B: B gets exactly one journey.started run with lineage and depth parent + 1, and runs", async () => {
    const b = journey("B", "journey.started", [task]);
    const a = journey("A", "manual", [start(b)]);

    await enroll(a);

    const runA = only(a);
    const runB = only(b);
    assert.equal(runB.triggerEvent, "journey.started");
    assert.deepEqual(runB.triggerPayload, {
      origin: "journey",
      origin_run_id: runA.id,
      origin_journey_id: a,
      root_run_id: runA.id,
      causation_depth: 1,
    }, "lineage only: no parent step outputs or context");
    assert.equal(runB.contactId, contact);
    assert.equal(runA.status, "completed");
    assert.equal(runB.status, "completed");
    assert.deepEqual(performed, ["B:create_task"]);
    assert.equal(runCausationDepth(runA), 1);
    assert.equal(runCausationDepth(runB), 2);

    const step = stepAt(runA, 0);
    assert.equal(step.status, "completed");
    assert.deepEqual(step.output, { started: true, target_journey_id: b, run_id: runB.id, causation_depth: 1 });
  });

  it("the parent doesn't wait: its later steps run in the same pass, before the child runs", async () => {
    const b = journey("B", "journey.started", [task]);
    const a = journey("A", "manual", [start(b), task]);

    await enroll(a);

    assert.deepEqual(performed, ["A:create_task", "B:create_task"]);
    assert.equal(only(a).status, "completed");
  });

  it("a child that waits leaves the parent finished; the child is due later like any run", async () => {
    const b = journey("B", "journey.started", [waitDay, task]);
    const a = journey("A", "manual", [start(b), task]);

    await enroll(a);

    assert.equal(only(a).status, "completed");
    assert.equal(only(b).status, "waiting");
    assert.deepEqual(performed, ["A:create_task"]);
  });
});

describe("targeting", () => {
  it("only the configured journey starts, though others listen for journey.started", async () => {
    const b = journey("B", "journey.started", [task]);
    const c = journey("C", "journey.started", [task]);
    const a = journey("A", "manual", [start(b)]);

    await enroll(a);

    only(b);
    assert.equal(runsOf(c).length, 0);
    assert.deepEqual(performed, ["B:create_task"]);
  });

  it("journey.started never starts anything by itself: other events don't reach these journeys", async () => {
    const b = journey("B", "journey.started", [task]);
    await dispatchJourneyEvent(deps, { tenantId: tenant, type: "lead.created", sourceId: contact, contactId: contact, entityType: "contact", entityId: contact, payload: {} });
    assert.equal(runsOf(b).length, 0);
  });
});

describe("trigger filters and conditions", () => {
  it("the target's trigger filters are evaluated: a non-matching filter starts nothing and the parent continues", async () => {
    const qualified: ConditionRule = { field: "lead.lead_status", operator: "equals", value: "Qualified" };
    const b = journey("B", "journey.started", [task], { filters: [qualified] });
    const a = journey("A", "manual", [start(b), task]);

    await enroll(a);

    assert.equal(runsOf(b).length, 0);
    const runA = only(a);
    assert.equal(runA.status, "completed");
    assert.equal(stepAt(runA, 0).status, "skipped");
    assert.equal(stepAt(runA, 0).output?.skipped_reason, "trigger_filters_not_matched");
    assert.deepEqual(performed, ["A:create_task"]);
  });

  it("a matching filter starts the target", async () => {
    const isNew: ConditionRule = { field: "lead.lead_status", operator: "equals", value: "New" };
    const b = journey("B", "journey.started", [task], { filters: [isNew] });
    const a = journey("A", "manual", [start(b)]);
    await enroll(a);
    assert.equal(only(b).status, "completed");
  });

  it("the target's conditions are evaluated normally: a failing ALL condition takes No", async () => {
    const b = conditional(
      "B",
      { logic: "all", rules: [{ field: "lead.lead_status", operator: "equals", value: "New" }, { field: "lead.intent", operator: "equals", value: "Buyer" }] },
      [setStatus("Qualified")],
      [task],
    );
    const a = journey("A", "manual", [start(b)]);

    await enroll(a);

    const runB = only(b);
    assert.equal(runB.status, "completed");
    assert.deepEqual(performed, ["B:create_task"], "only the No branch ran");
    assert.equal(store.contacts.get(contact)!.lead.lead_status, "New");
  });

  it("a passing condition takes Yes", async () => {
    const b = conditional("B", { field: "lead.lead_status", operator: "equals", value: "New" }, [task], [setStatus("Qualified")]);
    await enroll(journey("A", "manual", [start(b)]));
    assert.equal(only(b).status, "completed");
    assert.deepEqual(performed, ["B:create_task"]);
  });
});

describe("self-start", () => {
  const graphStarting = (self: string, target: string): JourneySnapshot => ({
    nodes: [
      { id: "t", type: "trigger", name: "Trigger", description: "", config: { event: "manual", filters: [] } },
      { id: "s", type: "action", name: "Start", description: "", config: { action: "start_journey", journeyId: target } },
    ],
    connections: [{ id: "c", sourceNodeId: "t", targetNodeId: "s", sourceHandle: null, targetHandle: null }],
  });

  it("activation rejects a Start journey step that targets its own journey", () => {
    const self = randomUUID();
    const messages = activationIssues(graphStarting(self, self), self).map((issue) => issue.message);
    assert.deepEqual(messages, ['"Start": a journey can\'t start itself.']);
    assert.deepEqual(activationIssues(graphStarting(self, randomUUID()), self), [], "another journey is fine");
  });

  it("at runtime a stale self-targeting step is skipped, never starting a second run of the same journey", async () => {
    const a = randomUUID();
    journey("A", "manual", [start(a), task], { id: a });

    await enroll(a);

    const runA = only(a);
    assert.equal(runA.status, "completed");
    assert.equal(stepAt(runA, 0).output?.skipped_reason, "self_start");
    assert.deepEqual(performed, ["A:create_task"]);
  });

  it("even a self-start with depth to spare is refused (not left to the depth cap)", async () => {
    const a = randomUUID();
    journey("A", "journey.started", [start(a)], { id: a });
    const parent = journey("P", "manual", [start(a)]);
    await enroll(parent);
    const runA = only(a);
    assert.equal(stepAt(runA, 0).output?.skipped_reason, "self_start");
    assert.equal(runCausationDepth(runA), 2);
  });
});

describe("workspace isolation", () => {
  it("a journey in another workspace can't be started (reported as not found)", async () => {
    const other = randomUUID();
    const foreign = journey("Foreign", "journey.started", [task], { tenantId: other });
    const a = journey("A", "manual", [start(foreign), task]);

    await enroll(a);

    assert.equal(runsOf(foreign).length, 0);
    const runA = only(a);
    assert.equal(runA.status, "completed");
    assert.deepEqual(stepAt(runA, 0).output, { started: false, target_journey_id: foreign, skipped_reason: "target_not_found" });
    assert.deepEqual(performed, ["A:create_task"]);
  });
});

describe("target lifecycle", () => {
  for (const status of ["archived", "paused", "draft"] as JourneyStatus[]) {
    it(`a ${status} target is skipped (target_inactive) and the parent continues`, async () => {
      const b = journey("B", "journey.started", [task], { status });
      const a = journey("A", "manual", [start(b), task]);

      await enroll(a);

      assert.equal(runsOf(b).length, 0);
      const runA = only(a);
      assert.equal(runA.status, "completed");
      assert.deepEqual(stepAt(runA, 0).output, { started: false, target_journey_id: b, target_status: status, skipped_reason: "target_inactive" });
      assert.deepEqual(performed, ["A:create_task"]);
    });
  }

  it("an unknown target is skipped (target_not_found)", async () => {
    const missing = randomUUID();
    const a = journey("A", "manual", [start(missing), task]);
    await enroll(a);
    const runA = only(a);
    assert.equal(runA.status, "completed");
    assert.equal(stepAt(runA, 0).output?.skipped_reason, "target_not_found");
  });

  it("a target that doesn't listen for journey.started is skipped (target_not_listening)", async () => {
    const b = journey("B", "manual", [task]);
    const a = journey("A", "manual", [start(b), task]);
    await enroll(a);
    assert.equal(runsOf(b).length, 0);
    const runA = only(a);
    assert.equal(runA.status, "completed");
    assert.equal(stepAt(runA, 0).output?.skipped_reason, "target_not_listening");
  });

  it("a run without a contact starts nothing (no_contact)", async () => {
    const b = journey("B", "journey.started", [task]);
    const a = journey("A", "manual", [start(b)]);
    await enroll(a, null);
    assert.equal(runsOf(b).length, 0);
    assert.equal(stepAt(only(a), 0).output?.skipped_reason, "no_contact");
  });
});

describe("one active run per contact", () => {
  it("a target already active for the contact gets no second run; the parent continues", async () => {
    const b = journey("B", "journey.started", [waitDay, task]);
    const a = journey("A", "manual", [start(b), task]);
    await enroll(a);
    assert.equal(only(b).status, "waiting");

    await enroll(a);

    assert.equal(runsOf(b).length, 1, "no duplicate B run, nothing queued");
    const second = runsOf(a)[1];
    assert.equal(second.status, "completed");
    assert.equal(stepAt(second, 0).output?.skipped_reason, "already_active");
    assert.deepEqual(performed, ["A:create_task", "A:create_task"]);
  });
});

describe("causation", () => {
  it("A → B → C → D by Start journey: D isn't created; C's step is a depth-limited skip, not a failure", async () => {
    const d = journey("D", "journey.started", [task]);
    const c = journey("C", "journey.started", [start(d), task]);
    const b = journey("B", "journey.started", [start(c)]);
    const a = journey("A", "manual", [start(b)]);

    await enroll(a);

    const [runA, runB, runC] = [only(a), only(b), only(c)];
    assert.equal(runsOf(d).length, 0);
    assert.deepEqual([runA, runB, runC].map(runCausationDepth), [1, 2, 3]);
    assert.deepEqual([runB, runC].map((run) => run.triggerPayload.causation_depth), [1, 2]);
    assert.equal(runC.status, "completed");
    assert.deepEqual(stepAt(runC, 0).output, { started: false, target_journey_id: d, causation_depth: 3, skipped_reason: "depth_limited" });
    assert.deepEqual(performed, ["C:create_task"]);
  });

  // Parent = a run started by journey.started with this recorded depth; child depth = parent's run depth.
  for (const [recorded, child] of [[0, 1], [1, 2], [2, null], [3, null]] as const) {
    it(`a parent with recorded depth ${recorded} ${child === null ? "starts no child (limit)" : `starts a child at depth ${child}`}`, async () => {
      const target = journey("T", "journey.started", [task]);
      const parent = journey("P", "journey.started", [start(target)]);
      const created = await store.createRun({
        tenantId: tenant, journeyId: parent, journeyVersion: 1, contactId: contact, entityType: "contact", entityId: contact,
        currentNodeId: `${parent}:t`, triggerEvent: "journey.started", triggerPayload: { origin: "journey", causation_depth: recorded },
        idempotencyKey: randomUUID(), resumeAt: new Date().toISOString(),
      });
      await executeRun(deps, created.run!.id);

      if (child === null) {
        assert.equal(runsOf(target).length, 0);
        assert.equal(stepAt(only(parent), 0).output?.skipped_reason, "depth_limited");
      } else {
        assert.equal(only(target).triggerPayload.causation_depth, child);
      }
      assert.equal(only(parent).status, "completed");
    });
  }

  it("a manually enrolled parent (no recorded depth) starts its child at depth 1", async () => {
    const b = journey("B", "journey.started", [task]);
    await enroll(journey("A", "manual", [start(b)]));
    assert.equal(only(b).triggerPayload.causation_depth, 1);
  });

  it("forged lineage on the parent can't lower the child's depth: only causation_depth counts", async () => {
    const target = journey("T", "journey.started", [task]);
    const parent = journey("P", "journey.started", [start(target)]);
    const created = await store.createRun({
      tenantId: tenant, journeyId: parent, journeyVersion: 1, contactId: contact, entityType: "contact", entityId: contact,
      currentNodeId: `${parent}:t`, triggerEvent: "journey.started",
      triggerPayload: { causation_depth: 2, root_run_id: "garbage", origin_journey_id: target, origin_run_id: null },
      idempotencyKey: randomUUID(), resumeAt: new Date().toISOString(),
    });
    await executeRun(deps, created.run!.id);
    assert.equal(runsOf(target).length, 0);
    assert.equal(stepAt(only(parent), 0).output?.skipped_reason, "depth_limited");
  });

  it("retrying the run at the limit can't open the chain", async () => {
    const d = journey("D", "journey.started", [task]);
    const c = journey("C", "journey.started", [task, start(d)]);
    const b = journey("B", "journey.started", [start(c)]);
    const a = journey("A", "manual", [start(b)]);
    failNextTask.add("C");

    await enroll(a);
    const runC = only(c);
    assert.equal(runC.status, "failed");

    await retry(runC);

    assert.equal(only(c).status, "completed");
    assert.equal(runsOf(d).length, 0);
    assert.equal(stepAt(only(c), 1).output?.skipped_reason, "depth_limited");
  });

  it("mixed chain: A starts B, B's status change starts C one level deeper with A's root; C can't start D", async () => {
    const d = journey("D", "journey.started", [task]);
    const c = journey("C", "lead.status_changed", [start(d)], { filters: [{ field: "trigger.to_status", operator: "equals", value: "Qualified" }] });
    const b = journey("B", "journey.started", [setStatus("Qualified")]);
    const a = journey("A", "manual", [start(b)]);

    await enroll(a);
    await drainOutbox();

    const [runA, runB, runC] = [only(a), only(b), only(c)];
    assert.deepEqual(lineage(runC), { origin: "journey", origin_run_id: runB.id, origin_journey_id: b, root_run_id: runA.id, causation_depth: 2 });
    assert.equal(runCausationDepth(runC), 3);
    assert.equal(runsOf(d).length, 0);
    assert.equal(stepAt(runC, 0).output?.skipped_reason, "depth_limited");
  });

  it("mixed chain: a run started by a journey's status change starts a child one level deeper with the same root", async () => {
    const c = journey("C", "journey.started", [task]);
    const b = journey("B", "lead.status_changed", [start(c)], { filters: [{ field: "trigger.to_status", operator: "equals", value: "Working" }] });
    const a = journey("A", "manual", [setStatus("Working")]);

    await enroll(a);
    await drainOutbox();

    const [runA, runB, runC] = [only(a), only(b), only(c)];
    assert.equal(runB.triggerPayload.root_run_id, runA.id);
    assert.deepEqual(lineage(runC), { origin: "journey", origin_run_id: runB.id, origin_journey_id: b, root_run_id: runA.id, causation_depth: 2 });
  });
});

describe("idempotency", () => {
  it("executing the same start step again (finished child) reports a duplicate and creates nothing", async () => {
    const b = journey("B", "journey.started", [task]);
    const a = journey("A", "manual", [start(b)]);
    await enroll(a);
    const runA = only(a);
    const runB = only(b);

    rewind(runA, 0);
    await executeRun(deps, runA.id);

    assert.equal(only(b).id, runB.id);
    assert.deepEqual(stepAt(only(a), 0).output, { started: true, target_journey_id: b, run_id: runB.id, causation_depth: 1, duplicate: true });
    assert.deepEqual(performed, ["B:create_task"], "the child didn't run again");
  });

  it("executing the same start step again (child still active) reuses that exact child: no second run, reported as started", async () => {
    const b = journey("B", "journey.started", [waitDay]);
    const a = journey("A", "manual", [start(b), task]);
    await enroll(a);
    const child = only(b);

    rewind(only(a), 0);
    await executeRun(deps, only(a).id);

    assert.equal(only(b).id, child.id);
    assert.equal(only(b).status, "waiting");
    assert.equal(stepAt(only(a), 0).status, "completed");
    assert.deepEqual(stepAt(only(a), 0).output, { started: true, target_journey_id: b, run_id: child.id, causation_depth: 1, duplicate: true });
    assert.equal(only(a).status, "completed", "a step that doesn't wait still doesn't wait");
    assert.equal(only(a).context.waitingForChild, undefined);
  });

  it("retrying a parent that failed after starting its child doesn't start a second child", async () => {
    const b = journey("B", "journey.started", [task]);
    const a = journey("A", "manual", [start(b), task]);
    failNextTask.add("A");

    await enroll(a);
    assert.equal(only(a).status, "failed");
    const runB = only(b);

    await retry(only(a));

    assert.equal(only(a).status, "completed");
    assert.equal(only(b).id, runB.id);
    assert.deepEqual(performed, ["B:create_task", "A:create_task"]);
  });

  it("an interrupted start step is repeated on resume without a second child", async () => {
    const b = journey("B", "journey.started", [task]);
    const a = journey("A", "manual", [start(b)]);
    await enroll(a);
    const runA = store.runs.get(only(a).id)!;
    const stepId = stepAt(runA, 0).id;
    // As if the pass died after the child was created but before the step was recorded.
    store.steps.find((step) => step.id === stepId)!.status = "running";
    Object.assign(runA, { status: "running", currentNodeId: `${a}:0`, lockedUntil: null, completedAt: null, resumeAt: new Date().toISOString(), context: { ...runA.context, inFlight: { nodeId: `${a}:0`, stepId } } });

    await resumeDueRuns(deps);

    assert.equal(runsOf(b).length, 1);
    assert.equal(only(a).status, "completed");
    assert.equal(stepAt(only(a), 0).output?.duplicate, true);
  });

  it("redelivering the same journey.started event (even after the target is saved again) creates no run", async () => {
    const b = journey("B", "journey.started", [task]);
    const a = journey("A", "manual", [start(b)]);
    await enroll(a);
    const runA = only(a);
    const event: JourneyEvent = {
      tenantId: tenant, type: "journey.started", sourceId: `${runA.id}:${a}:0`, journeyId: b,
      contactId: contact, entityType: "contact", entityId: contact, payload: { origin: "journey", causation_depth: 0 },
    };

    store.saveJourney(tenant, b, structuredClone(store.journeys.get(b)!.versions.get(1)!));
    const outcomes = await dispatchJourneyEvent(deps, event);

    assert.deepEqual(outcomes.map((outcome) => outcome.result), ["duplicate"]);
    assert.equal(runsOf(b).length, 1);
  });

  it("two racing deliveries of the same start create one run", async () => {
    const b = journey("B", "journey.started", [waitDay]);
    const event: JourneyEvent = {
      tenantId: tenant, type: "journey.started", sourceId: `${randomUUID()}:node`, journeyId: b,
      contactId: contact, entityType: "contact", entityId: contact, payload: { origin: "journey", causation_depth: 1 },
    };

    const results = await Promise.all([dispatchJourneyEvent(deps, event, { execute: false }), dispatchJourneyEvent(deps, event, { execute: false })]);

    assert.equal(runsOf(b).length, 1);
    const outcomes = results.flat().map((outcome) => outcome.result);
    assert.equal(outcomes.filter((result) => result === "started").length, 1);
    assert.ok(outcomes.every((result) => ["started", "duplicate", "already_active"].includes(result)), outcomes.join());
  });

  it("two Start journey steps (different nodes) for the same target: the second finds it active", async () => {
    const b = journey("B", "journey.started", [waitDay]);
    const a = journey("A", "manual", [start(b), start(b)]);
    await enroll(a);
    assert.equal(runsOf(b).length, 1);
    assert.equal(stepAt(only(a), 1).output?.skipped_reason, "already_active");
  });
});

describe("the step's own child: only its exact run key makes a run the step's child", () => {
  const startAndWait = (journeyId: string): Step => ({ ...start(journeyId), waitForCompletion: true });

  /** As if the pass died after step `<journey>:<index>` created its child but before the step was recorded. */
  function interruptAfterChildCreated(run: MemoryRun, index: number) {
    const live = store.runs.get(run.id)!;
    const stepId = stepAt(live, index).id;
    Object.assign(store.steps.find((step) => step.id === stepId)!, { status: "running", output: {}, completedAt: null });
    Object.assign(live, {
      status: "running", currentNodeId: `${run.journeyId}:${index}`, lockedUntil: null, completedAt: null,
      resumeAt: new Date().toISOString(), context: { ...live.context, inFlight: { nodeId: `${run.journeyId}:${index}`, stepId } },
    });
  }

  /** A's Start journey step (doesn't wait) started B, then A's pass died before recording it; B is then put in `state`. */
  async function interruptedNonWaitingStart(state: (child: MemoryRun) => void) {
    const b = journey("B", "journey.started", [waitDay]);
    const a = journey("A", "manual", [start(b), task]);
    await enroll(a);
    const child = only(b);
    state(store.runs.get(child.id)!);
    interruptAfterChildCreated(only(a), 0);
    performed = [];
    await resumeDueRuns(deps);
    return { a, b, child };
  }

  /** Enrolls the lead with the run left due, so the test runs (and interleaves) its pass. */
  const enrollUnexecuted = (journeyId: string) =>
    dispatchJourneyEvent(
      deps,
      { tenantId: tenant, type: "manual", journeyId, sourceId: randomUUID(), contactId: contact, entityType: "contact", entityId: contact, payload: {} },
      { execute: false },
    );

  const reused = (b: string, child: MemoryRun) => ({ started: true, target_journey_id: b, run_id: child.id, causation_depth: 1, duplicate: true });

  it("M1: interrupted after creating its child, child still active: the exact child is reused, no second run, still doesn't wait", async () => {
    const { a, b, child } = await interruptedNonWaitingStart(() => {});
    assert.equal(only(b).id, child.id);
    assert.equal(only(b).idempotencyKey, idempotencyKey({ type: "journey.started", sourceId: `${only(a).id}:${a}:0` }, b, 0));
    assert.equal(only(b).status, "waiting", "the child keeps its actual state");
    assert.equal(stepAt(only(a), 0).status, "completed");
    assert.deepEqual(stepAt(only(a), 0).output, reused(b, child));
    assert.equal(only(a).status, "completed");
    assert.equal(only(a).context.waitingForChild, undefined);
    assert.deepEqual(performed, ["A:create_task"], "the journey went on to its next step once; B didn't run again");
  });

  it("M1: the child's journey was paused since (child paused): still the step's child, not target_inactive or already_active", async () => {
    const { a, b, child } = await interruptedNonWaitingStart((run) => {
      store.setStatus(run.journeyId, "paused");
      run.status = "paused";
    });
    assert.equal(only(b).id, child.id);
    assert.equal(only(b).status, "paused");
    assert.deepEqual(stepAt(only(a), 0).output, reused(b, child));
    assert.equal(only(a).status, "completed");
  });

  for (const status of ["completed", "failed", "cancelled"] as const) {
    it(`M1: interrupted after creating its child, child ${status}: the exact child is reused, no second run`, async () => {
      const { a, b, child } = await interruptedNonWaitingStart((run) => {
        run.status = status;
      });
      assert.equal(only(b).id, child.id);
      assert.equal(only(b).status, status);
      assert.deepEqual(stepAt(only(a), 0).output, reused(b, child));
      assert.equal(only(a).status, "completed");
    });
  }

  it("M1: a run of the target that isn't this step's (the lead is already in it) is never adopted, waiting or not", async () => {
    const b = journey("B", "journey.started", [waitDay]);
    await enroll(journey("X", "manual", [start(b)]));
    const unrelated = only(b);

    const a = journey("A", "manual", [start(b), startAndWait(b), task]);
    await enroll(a);

    assert.equal(only(b).id, unrelated.id);
    for (const index of [0, 1]) {
      assert.equal(stepAt(only(a), index).status, "skipped");
      assert.equal(stepAt(only(a), index).output?.skipped_reason, "already_active");
      assert.equal(stepAt(only(a), index).output?.run_id, undefined);
    }
    assert.equal(only(a).status, "completed", "nothing waited for");
  });

  /**
   * Overlapping passes: while this pass (the lease holder) is between its own
   * run-key lookup and its insert, `meanwhile` runs (another pass of the same
   * step inserting the child, or something else starting the target).
   */
  function duringNextActiveRunCheck(meanwhile: () => Promise<unknown>) {
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

  /** What another pass of `run`'s step `<journey>:<index>` sends for `target`: the same journey.started event. */
  const samePassStart = (run: MemoryRun, index: number, target: string) =>
    dispatchJourneyEvent(
      deps,
      {
        tenantId: tenant, type: "journey.started", sourceId: `${run.id}:${run.journeyId}:${index}`, journeyId: target,
        contactId: contact, entityType: "contact", entityId: contact,
        payload: { origin: "journey", origin_run_id: run.id, origin_journey_id: run.journeyId, root_run_id: run.id, causation_depth: 1 },
      },
      { execute: false },
    );

  it("M2: overlapping passes of a waiting Start journey step: the child the other pass created is found and waited for", async () => {
    const b = journey("B", "journey.started", [task]);
    const a = journey("A", "manual", [startAndWait(b), task]);
    await enrollUnexecuted(a);
    const parent = only(a);

    duringNextActiveRunCheck(() => samePassStart(parent, 0, b));
    const outcome = await executeRun(deps, parent.id);

    const child = only(b);
    assert.equal(stepAt(only(a), 0).output?.run_id, child.id);
    assert.equal(stepAt(only(a), 0).output?.duplicate, true);
    assert.equal(stepAt(only(a), 0).output?.skipped_reason, undefined);
    assert.equal(outcome.waitingForChild, child.id, "parked on the exact child");
    await resumeDueRuns(deps);
    await resumeDueRuns(deps);
    assert.equal(only(b).id, child.id, "one child");
    assert.equal(only(a).status, "completed");
    assert.equal(stepAt(only(a), 0).output?.child_status, "completed", "the parent waited for that exact child");
    assert.deepEqual(performed.filter((entry) => entry === "A:create_task"), ["A:create_task"]);
  });

  it("M2: overlapping passes of a fan-out step: each child exists once and the step waits for both", async () => {
    const [b, c] = [journey("B", "journey.started", [waitDay]), journey("C", "journey.started", [waitDay])];
    const fanOut: Step = { action: "start_journeys", journeys: [{ journeyId: b }, { journeyId: c }], waitForCompletion: true, completion: "all" };
    const a = journey("A", "manual", [fanOut, task]);
    await enrollUnexecuted(a);
    const parent = only(a);
    duringNextActiveRunCheck(async () => {
      await samePassStart(parent, 0, b);
      await samePassStart(parent, 0, c);
    });
    await executeRun(deps, parent.id);

    const [childB, childC] = [only(b), only(c)];
    const live = only(a);
    assert.equal(live.status, "waiting");
    assert.deepEqual(live.context.waitingForChildren?.children.map((entry) => entry.runId).sort(), [childB.id, childC.id].sort());
    const children = stepAt(live, 0).output?.children as Record<string, Record<string, unknown>>;
    assert.deepEqual(Object.values(children).map((record) => [record.run_id, record.started, record.skipped_reason]).sort(), [
      [childB.id, true, undefined],
      [childC.id, true, undefined],
    ].sort());
  });

  it("M2: something else starting the target while this pass is between lookup and insert is still never adopted", async () => {
    const b = journey("B", "journey.started", [waitDay]);
    const x = journey("X", "manual", [start(b)]);
    const a = journey("A", "manual", [startAndWait(b), task]);
    await enrollUnexecuted(a);
    duringNextActiveRunCheck(() => enroll(x));
    await executeRun(deps, only(a).id);

    const unrelated = only(b);
    assert.equal(unrelated.triggerPayload.origin_journey_id, x);
    assert.equal(stepAt(only(a), 0).output?.skipped_reason, "already_active");
    assert.equal(stepAt(only(a), 0).output?.run_id, undefined);
    assert.equal(only(a).status, "completed", "not waited for");
  });
});

describe("lineage", () => {
  it("A → B → C: each origin is the immediate parent, the root stays A's run, depth rises once per start", async () => {
    const c = journey("C", "journey.started", [task]);
    const b = journey("B", "journey.started", [start(c)]);
    const a = journey("A", "manual", [start(b)]);

    await enroll(a);

    const [runA, runB, runC] = [only(a), only(b), only(c)];
    assert.deepEqual(lineage(runB), { origin: "journey", origin_run_id: runA.id, origin_journey_id: a, root_run_id: runA.id, causation_depth: 1 });
    assert.deepEqual(lineage(runC), { origin: "journey", origin_run_id: runB.id, origin_journey_id: b, root_run_id: runA.id, causation_depth: 2 });
  });

  it("a parent's step outputs never reach the child", async () => {
    const b = journey("B", "journey.started", [task]);
    const a = journey("A", "manual", [task, setStatus("Working"), start(b)]);
    await enroll(a);
    assert.deepEqual(Object.keys(only(b).triggerPayload).sort(), ["causation_depth", "origin", "origin_journey_id", "origin_run_id", "root_run_id"]);
    assert.deepEqual(only(b).context.steps[Object.keys(only(b).context.steps)[0]].output, {
      event: "journey.started",
      ...only(b).triggerPayload,
    });
  });
});
