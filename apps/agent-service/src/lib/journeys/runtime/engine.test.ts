import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";
import type { JourneyAIExecutor, JourneyAIRequest, JourneyAIResult } from "./ai.ts";
import {
  dispatchJourneyEvent,
  executeRun,
  JourneyStepError,
  MAX_ATTEMPTS,
  resumeDueRuns,
  type ActionExecutor,
  type ActionInput,
  type EngineDeps,
  type JourneyEvent,
} from "./engine.ts";
import type { JourneySnapshot, SnapshotNode } from "./graph.ts";
import { MemoryJourneyStore } from "./memory-store.ts";

const TENANT = "tenant-a";
const OTHER_TENANT = "tenant-b";
const LEAD = "contact-1";

function node(id: string, type: SnapshotNode["type"], name: string, config: Record<string, unknown>): SnapshotNode {
  return { id, type, name, description: "", config };
}

function link(source: string, target: string, sourceHandle: string | null = null) {
  return { id: `${source}->${target}`, sourceNodeId: source, targetNodeId: target, sourceHandle, targetHandle: null };
}

/** Trigger → Action → Condition → (yes) Action / (no) Action */
function branchingJourney(): JourneySnapshot {
  return {
    nodes: [
      node("t", "trigger", "New lead", { event: "lead.created", filters: [] }),
      node("a1", "action", "Assign", { action: "assign_lead", agentUserId: "11111111-1111-1111-1111-111111111111" }),
      node("c", "condition", "Is hot?", { field: "lead.lead_temperature", operator: "equals", value: "Hot" }),
      node("yes", "action", "Text hot lead", { action: "send_sms", body: "Hi {{first_name}}" }),
      node("no", "action", "Nurture task", { action: "create_task", title: "Nurture", notes: "", dueInDays: 3 }),
    ],
    connections: [link("t", "a1"), link("a1", "c"), link("c", "yes", "yes"), link("c", "no", "no")],
  };
}

/** Trigger → Wait 2 days → Action */
function waitingJourney(): JourneySnapshot {
  return {
    nodes: [
      node("t", "trigger", "New lead", { event: "lead.created", filters: [] }),
      node("w", "action", "Wait", { action: "wait", duration: 2, unit: "days" }),
      node("s", "action", "Follow up", { action: "send_sms", body: "Checking in" }),
    ],
    connections: [link("t", "w"), link("w", "s")],
  };
}

class RecordingActions implements ActionExecutor {
  calls: Array<{ action: string; input: ActionInput }> = [];
  failures: Array<Error> = [];
  async execute(action: Parameters<ActionExecutor["execute"]>[0], input: ActionInput) {
    this.calls.push({ action: action.action, input });
    const failure = this.failures.shift();
    if (failure) throw failure;
    return { status: "completed" as const, output: { action: action.action, ok: true } };
  }
  names() {
    return this.calls.map((call) => call.action);
  }
}

class FakeAI implements JourneyAIExecutor {
  requests: JourneyAIRequest[] = [];
  results: Array<JourneyAIResult | Error> = [];
  async execute(request: JourneyAIRequest): Promise<JourneyAIResult> {
    this.requests.push(structuredClone(request));
    const next = this.results.shift() ?? { success: true, output: {}, text: "" };
    if (next instanceof Error) throw next;
    return next;
  }
}

function leadEvent(sourceId = LEAD, tenantId = TENANT): JourneyEvent {
  return {
    tenantId,
    type: "lead.created",
    sourceId,
    contactId: LEAD,
    entityType: "contact",
    entityId: LEAD,
    payload: { channel: "sms" },
  };
}

let store: MemoryJourneyStore;
let actions: RecordingActions;
let ai: FakeAI;
let clock: Date;
let deps: EngineDeps;

beforeEach(() => {
  store = new MemoryJourneyStore();
  actions = new RecordingActions();
  ai = new FakeAI();
  clock = new Date("2026-10-01T12:00:00Z");
  deps = { store, actions, ai, now: () => new Date(clock) };
  store.contacts.set(LEAD, { tenantId: TENANT, lead: { first_name: "Ana", lead_temperature: "Hot" } });
});

function advance(ms: number) {
  clock = new Date(clock.getTime() + ms);
}

describe("trigger → action → condition → action → completion", () => {
  it("takes the Yes branch when the condition is true", async () => {
    store.saveJourney(TENANT, "j1", branchingJourney());
    const [outcome] = await dispatchJourneyEvent(deps, leadEvent());

    assert.equal(outcome.result, "started");
    assert.equal(outcome.execution?.status, "completed");
    assert.deepEqual(actions.names(), ["assign_lead", "send_sms"]);
    const steps = store.stepsFor(outcome.runId!);
    assert.deepEqual(steps.map((s) => s.nodeId), ["t", "a1", "c", "yes"]);
    assert.deepEqual(steps.find((s) => s.nodeId === "c")?.output, { result: true, branch: "yes" });
    const run = store.runs.get(outcome.runId!)!;
    assert.equal(run.status, "completed");
    assert.equal(run.lockedUntil, null);
    assert.ok(run.completedAt);
  });

  it("takes the No branch when the condition is false", async () => {
    store.contacts.get(LEAD)!.lead.lead_temperature = "Cold";
    store.saveJourney(TENANT, "j1", branchingJourney());
    const [outcome] = await dispatchJourneyEvent(deps, leadEvent());

    assert.equal(outcome.execution?.status, "completed");
    assert.deepEqual(actions.names(), ["assign_lead", "create_task"]);
  });

  it("ends the run when the chosen branch isn't connected", async () => {
    store.contacts.get(LEAD)!.lead.lead_temperature = "Cold";
    const journey = branchingJourney();
    journey.connections = journey.connections.filter((c) => c.sourceHandle !== "no");
    store.saveJourney(TENANT, "j1", journey);
    const [outcome] = await dispatchJourneyEvent(deps, leadEvent());

    assert.equal(outcome.execution?.status, "completed");
    assert.deepEqual(actions.names(), ["assign_lead"]);
  });

  it("exposes earlier step output to later conditions", async () => {
    const journey = branchingJourney();
    journey.nodes[2] = node("c", "condition", "Assigned?", {
      field: "steps.assign.output.ok",
      operator: "equals",
      value: true,
    });
    store.contacts.get(LEAD)!.lead.lead_temperature = "Cold";
    store.saveJourney(TENANT, "j1", journey);
    await dispatchJourneyEvent(deps, leadEvent());

    assert.deepEqual(actions.names(), ["assign_lead", "send_sms"]);
  });

  it("passes the run's tenant and contact to actions", async () => {
    store.saveJourney(TENANT, "j1", branchingJourney());
    await dispatchJourneyEvent(deps, leadEvent());
    for (const call of actions.calls) {
      assert.equal(call.input.tenantId, TENANT);
      assert.equal(call.input.contactId, LEAD);
      assert.equal(call.input.lead?.first_name, "Ana");
    }
  });
});

describe("trigger filters", () => {
  it("doesn't start a run when a trigger filter fails", async () => {
    const journey = branchingJourney();
    journey.nodes[0].config.filters = [{ field: "trigger.channel", operator: "equals", value: "instagram" }];
    store.saveJourney(TENANT, "j1", journey);
    const [outcome] = await dispatchJourneyEvent(deps, leadEvent());

    assert.equal(outcome.result, "filtered");
    assert.equal(store.runs.size, 0);
  });

  it("ignores journeys that listen for other events or aren't active", async () => {
    const other = branchingJourney();
    other.nodes[0].config.event = "task.completed";
    store.saveJourney(TENANT, "j-other", other);
    store.saveJourney(TENANT, "j-paused", branchingJourney(), "paused");
    store.saveJourney(TENANT, "j-draft", branchingJourney(), "draft");

    assert.deepEqual(await dispatchJourneyEvent(deps, leadEvent()), []);
  });
});

describe("trigger → wait → resume → action → completion", () => {
  it("parks the run without blocking, then resumes when due", async () => {
    store.saveJourney(TENANT, "j1", waitingJourney());
    const [outcome] = await dispatchJourneyEvent(deps, leadEvent());
    const runId = outcome.runId!;

    assert.equal(outcome.execution?.status, "waiting");
    assert.deepEqual(actions.names(), []);
    const parked = store.runs.get(runId)!;
    assert.equal(parked.currentNodeId, "w");
    assert.equal(parked.resumeAt, "2026-10-03T12:00:00.000Z");
    assert.equal(parked.lockedUntil, null);
    assert.equal(store.stepsFor(runId).find((s) => s.nodeId === "w")?.status, "running");

    advance(24 * 60 * 60_000);
    assert.equal((await resumeDueRuns(deps)).processed, 0, "not due yet");

    advance(24 * 60 * 60_000);
    const resumed = await resumeDueRuns(deps);
    assert.equal(resumed.processed, 1);
    assert.equal(resumed.outcomes[0].status, "completed");
    assert.deepEqual(actions.names(), ["send_sms"]);
    const waitStep = store.stepsFor(runId).find((s) => s.nodeId === "w")!;
    assert.equal(waitStep.status, "completed");
    assert.equal(store.runs.get(runId)!.status, "completed");
  });

  it("pauses due runs while the journey is paused and continues after resume", async () => {
    store.saveJourney(TENANT, "j1", waitingJourney());
    const [outcome] = await dispatchJourneyEvent(deps, leadEvent());
    store.setStatus("j1", "paused");
    advance(3 * 24 * 60 * 60_000);

    await resumeDueRuns(deps);
    const run = store.runs.get(outcome.runId!)!;
    assert.equal(run.status, "paused");
    assert.deepEqual(actions.names(), []);

    store.setStatus("j1", "active");
    run.status = "waiting";
    run.resumeAt = clock.toISOString();
    await resumeDueRuns(deps);
    assert.equal(store.runs.get(outcome.runId!)!.status, "completed");
    assert.deepEqual(actions.names(), ["send_sms"]);
  });

  it("doesn't touch a run that was cancelled while waiting", async () => {
    store.saveJourney(TENANT, "j1", waitingJourney());
    const [outcome] = await dispatchJourneyEvent(deps, leadEvent());
    store.runs.get(outcome.runId!)!.status = "cancelled";
    advance(3 * 24 * 60 * 60_000);

    assert.equal((await resumeDueRuns(deps)).processed, 0);
    assert.equal((await executeRun(deps, outcome.runId!)).status, "not_claimed");
    assert.deepEqual(actions.names(), []);
  });
});

describe("failures and retries", () => {
  it("retries transient errors with backoff, then succeeds", async () => {
    actions.failures.push(new Error("Twilio timeout"));
    store.saveJourney(TENANT, "j1", branchingJourney());
    const [outcome] = await dispatchJourneyEvent(deps, leadEvent());
    const runId = outcome.runId!;

    assert.equal(outcome.execution?.status, "waiting");
    assert.equal(store.runs.get(runId)!.resumeAt, "2026-10-01T12:01:00.000Z");
    const failed = store.stepsFor(runId).find((s) => s.nodeId === "a1")!;
    assert.equal(failed.status, "failed");
    assert.equal(failed.errorKind, "transient");

    advance(60_000);
    await resumeDueRuns(deps);
    assert.equal(store.runs.get(runId)!.status, "completed");
    const attempts = store.stepsFor(runId).filter((s) => s.nodeId === "a1");
    assert.deepEqual(attempts.map((s) => [s.status, s.attemptCount]), [["failed", 1], ["completed", 2]]);
  });

  it(`fails the run after ${MAX_ATTEMPTS} transient attempts`, async () => {
    for (let i = 0; i < MAX_ATTEMPTS; i++) actions.failures.push(new Error("Service unavailable"));
    store.saveJourney(TENANT, "j1", branchingJourney());
    const [outcome] = await dispatchJourneyEvent(deps, leadEvent());
    const runId = outcome.runId!;
    for (let i = 0; i < MAX_ATTEMPTS; i++) {
      advance(60 * 60_000);
      await resumeDueRuns(deps);
    }
    const run = store.runs.get(runId)!;
    assert.equal(run.status, "failed");
    assert.equal(run.error, "Service unavailable");
    assert.equal(store.stepsFor(runId).filter((s) => s.nodeId === "a1").length, MAX_ATTEMPTS);
  });

  it("fails immediately on configuration errors", async () => {
    actions.failures.push(new JourneyStepError("The lead has no mobile number.", "config"));
    store.saveJourney(TENANT, "j1", branchingJourney());
    const [outcome] = await dispatchJourneyEvent(deps, leadEvent());

    assert.equal(outcome.execution?.status, "failed");
    const run = store.runs.get(outcome.runId!)!;
    assert.equal(run.error, "The lead has no mobile number.");
    assert.equal(run.resumeAt, null);
    assert.equal(store.stepsFor(outcome.runId!).at(-1)?.errorKind, "config");
  });

  it("doesn't repeat a non-idempotent step that was interrupted", async () => {
    store.saveJourney(TENANT, "j1", waitingJourney());
    const [outcome] = await dispatchJourneyEvent(deps, leadEvent());
    const run = store.runs.get(outcome.runId!)!;
    run.context = { steps: {}, inFlight: { nodeId: "s", stepId: "step-x" } };
    run.currentNodeId = "s";
    run.status = "running";
    run.resumeAt = clock.toISOString();

    const result = await executeRun(deps, run.id);
    assert.equal(result.status, "failed");
    assert.deepEqual(actions.names(), []);
  });
});

const AI_INSTRUCTIONS = "Return sales_ready (boolean), score (0-100), and reason.";

/** Trigger → Assign → AI "Qualify" → Condition on its output → (yes) Text / (no) Task */
function aiJourney(): JourneySnapshot {
  return {
    nodes: [
      node("t", "trigger", "New lead", { event: "lead.created", filters: [] }),
      node("a1", "action", "Assign", { action: "assign_lead", agentUserId: "11111111-1111-1111-1111-111111111111" }),
      node("ai", "ai", "Qualify", { goal: "Is this lead sales ready?", instructions: AI_INSTRUCTIONS, agent: "default" }),
      node("c", "condition", "Sales ready?", { field: "steps.qualify.output.sales_ready", operator: "equals", value: true }),
      node("yes", "action", "Text hot lead", { action: "send_sms", body: "Hi {{first_name}}" }),
      node("no", "action", "Nurture task", { action: "create_task", title: "Nurture", notes: "", dueInDays: 3 }),
    ],
    connections: [link("t", "a1"), link("a1", "ai"), link("ai", "c"), link("c", "yes", "yes"), link("c", "no", "no")],
  };
}

const READY: JourneyAIResult = {
  success: true,
  output: { sales_ready: true, score: 82, reason: "Asked for a showing and confirmed budget." },
  text: "Ready: asked for a showing and confirmed budget.",
};

describe("AI steps", () => {
  it("executes the AI node, persists its output, and branches on it", async () => {
    ai.results.push(READY);
    store.saveJourney(TENANT, "j1", aiJourney());
    const [outcome] = await dispatchJourneyEvent(deps, leadEvent());
    const runId = outcome.runId!;

    assert.equal(outcome.execution?.status, "completed");
    assert.equal(ai.requests.length, 1);
    const aiStep = store.stepsFor(runId).find((s) => s.nodeId === "ai")!;
    assert.equal(aiStep.status, "completed");
    assert.deepEqual(aiStep.output, {
      sales_ready: true,
      score: 82,
      reason: "Asked for a showing and confirmed budget.",
      ai_response: "Ready: asked for a showing and confirmed budget.",
    });
    assert.deepEqual(store.runs.get(runId)!.context.steps.qualify.output, aiStep.output);
    assert.deepEqual(store.stepsFor(runId).find((s) => s.nodeId === "c")?.output, { result: true, branch: "yes" });
    assert.deepEqual(actions.names(), ["assign_lead", "send_sms"]);
  });

  it("takes the No branch when the AI says the lead isn't ready", async () => {
    ai.results.push({ success: true, output: { sales_ready: false, score: 20 }, text: "Just browsing." });
    store.saveJourney(TENANT, "j1", aiJourney());
    await dispatchJourneyEvent(deps, leadEvent());
    assert.deepEqual(actions.names(), ["assign_lead", "create_task"]);
  });

  it("lets numeric conditions read AI scores", async () => {
    ai.results.push(READY);
    const journey = aiJourney();
    journey.nodes[3] = node("c", "condition", "High score", {
      field: "steps.qualify.output.score",
      operator: "greater_than_or_equal",
      value: 80,
    });
    store.saveJourney(TENANT, "j1", journey);
    await dispatchJourneyEvent(deps, leadEvent());
    assert.deepEqual(actions.names(), ["assign_lead", "send_sms"]);
  });

  it("gives the executor the workspace, journey, run, lead, earlier outputs, and instructions", async () => {
    ai.results.push(READY);
    store.contacts.get(LEAD)!.opportunity = { stage: "Qualified" };
    store.saveJourney(TENANT, "j1", aiJourney());
    const [outcome] = await dispatchJourneyEvent(deps, leadEvent());

    const [request] = ai.requests;
    assert.equal(request.tenantId, TENANT);
    assert.equal(request.journeyId, "j1");
    assert.equal(request.runId, outcome.runId);
    assert.equal(request.nodeId, "ai");
    assert.equal(request.stepKey, "qualify");
    assert.equal(request.contactId, LEAD);
    assert.equal(request.agent, "default");
    assert.equal(request.goal, "Is this lead sales ready?");
    assert.equal(request.instructions, AI_INSTRUCTIONS);
    assert.equal(request.context.lead?.first_name, "Ana");
    assert.deepEqual(request.context.opportunity, { stage: "Qualified" });
    assert.deepEqual(request.context.trigger, { event: "lead.created", payload: { channel: "sms" } });
    assert.deepEqual(Object.keys(request.context.steps), ["new_lead", "assign"]);
    assert.deepEqual(request.context.steps.assign.output, { action: "assign_lead", ok: true });
  });

  it("marks a failed AI step failed, persists the error, and retries without running later steps", async () => {
    ai.results.push({ success: false, error: "Model timed out.", retryable: true });
    store.saveJourney(TENANT, "j1", aiJourney());
    const [outcome] = await dispatchJourneyEvent(deps, leadEvent());
    const runId = outcome.runId!;

    assert.equal(outcome.execution?.status, "waiting");
    const failed = store.stepsFor(runId).find((s) => s.nodeId === "ai")!;
    assert.equal(failed.status, "failed");
    assert.equal(failed.error, "Model timed out.");
    assert.equal(failed.errorKind, "transient");
    assert.equal(failed.output, undefined);
    const run = store.runs.get(runId)!;
    assert.equal(run.error, "Model timed out.");
    assert.equal(run.currentNodeId, "ai");
    assert.equal(run.resumeAt, "2026-10-01T12:01:00.000Z");
    assert.equal(run.context.steps.qualify, undefined);
    assert.equal(store.stepsFor(runId).some((s) => s.nodeId === "c"), false);
    assert.deepEqual(actions.names(), ["assign_lead"]);

    ai.results.push(READY);
    advance(60_000);
    await resumeDueRuns(deps);
    assert.equal(store.runs.get(runId)!.status, "completed");
    const attempts = store.stepsFor(runId).filter((s) => s.nodeId === "ai");
    assert.deepEqual(attempts.map((s) => [s.status, s.attemptCount]), [["failed", 1], ["completed", 2]]);
    assert.deepEqual(actions.names(), ["assign_lead", "send_sms"], "the assign step isn't repeated");
  });

  it(`fails the run after ${MAX_ATTEMPTS} failed AI attempts`, async () => {
    for (let i = 0; i < MAX_ATTEMPTS; i++) ai.results.push(new Error("Service unavailable"));
    store.saveJourney(TENANT, "j1", aiJourney());
    const [outcome] = await dispatchJourneyEvent(deps, leadEvent());
    for (let i = 0; i < MAX_ATTEMPTS; i++) {
      advance(60 * 60_000);
      await resumeDueRuns(deps);
    }
    const run = store.runs.get(outcome.runId!)!;
    assert.equal(run.status, "failed");
    assert.equal(run.error, "Service unavailable");
    assert.equal(ai.requests.length, MAX_ATTEMPTS);
    assert.ok(store.stepsFor(run.id).filter((s) => s.nodeId === "ai").every((s) => s.status === "failed"));
    assert.deepEqual(actions.names(), ["assign_lead"]);
  });

  it("fails immediately when the AI step can't succeed by retrying", async () => {
    ai.results.push({ success: false, error: "AI isn't configured for REOS yet.", retryable: false });
    store.saveJourney(TENANT, "j1", aiJourney());
    const [outcome] = await dispatchJourneyEvent(deps, leadEvent());

    assert.equal(outcome.execution?.status, "failed");
    const run = store.runs.get(outcome.runId!)!;
    assert.equal(run.error, "AI isn't configured for REOS yet.");
    assert.equal(run.resumeAt, null);
    const step = store.stepsFor(run.id).find((s) => s.nodeId === "ai")!;
    assert.equal(step.errorKind, "config");
    assert.deepEqual(actions.names(), ["assign_lead"]);
  });

  it("never hands the executor a lead from another workspace", async () => {
    ai.results.push(READY);
    store.saveJourney(OTHER_TENANT, "j-b", aiJourney());
    await dispatchJourneyEvent(deps, leadEvent(LEAD, OTHER_TENANT));

    const [request] = ai.requests;
    assert.equal(request.tenantId, OTHER_TENANT);
    assert.equal(request.journeyId, "j-b");
    assert.equal(request.context.lead, null);
    assert.equal(request.context.opportunity, null);
  });
});

describe("versioning", () => {
  it("runs keep executing the version they started on", async () => {
    store.saveJourney(TENANT, "j1", waitingJourney());
    const [outcome] = await dispatchJourneyEvent(deps, leadEvent());
    assert.equal(store.runs.get(outcome.runId!)!.journeyVersion, 1);

    const edited = waitingJourney();
    edited.nodes[2] = node("s", "action", "Follow up", { action: "create_task", title: "Call", notes: "", dueInDays: 0 });
    assert.equal(store.saveJourney(TENANT, "j1", edited), 2);

    advance(3 * 24 * 60 * 60_000);
    await resumeDueRuns(deps);
    assert.deepEqual(actions.names(), ["send_sms"], "old run used v1");

    store.contacts.set("contact-2", { tenantId: TENANT, lead: {} });
    const [next] = await dispatchJourneyEvent(deps, { ...leadEvent("contact-2"), contactId: "contact-2" });
    assert.equal(store.runs.get(next.runId!)!.journeyVersion, 2);
  });
});

describe("idempotency", () => {
  it("starts one run per event, journey, and version", async () => {
    store.saveJourney(TENANT, "j1", branchingJourney());
    const first = await dispatchJourneyEvent(deps, leadEvent());
    store.runs.get(first[0].runId!)!.status = "completed";
    const second = await dispatchJourneyEvent(deps, leadEvent());

    assert.equal(first[0].result, "started");
    assert.equal(second[0].result, "duplicate");
    assert.equal(second[0].runId, first[0].runId);
    assert.equal(store.runs.size, 1);
    assert.deepEqual(actions.names(), ["assign_lead", "send_sms"]);
  });

  it("doesn't enroll a contact who is already in the journey", async () => {
    store.saveJourney(TENANT, "j1", waitingJourney());
    await dispatchJourneyEvent(deps, leadEvent("event-1"));
    const [again] = await dispatchJourneyEvent(deps, leadEvent("event-2"));
    assert.equal(again.result, "already_active");
    assert.equal(store.runs.size, 1);
  });

  it("only one concurrent executor wins the lease", async () => {
    store.saveJourney(TENANT, "j1", waitingJourney());
    const [outcome] = await dispatchJourneyEvent(deps, leadEvent());
    advance(3 * 24 * 60 * 60_000);
    const results = await Promise.all([executeRun(deps, outcome.runId!), executeRun(deps, outcome.runId!)]);
    assert.deepEqual(results.map((r) => r.status).sort(), ["completed", "not_claimed"]);
    assert.deepEqual(actions.names(), ["send_sms"]);
  });
});

describe("workspace isolation", () => {
  it("events only reach journeys in their own workspace", async () => {
    store.saveJourney(OTHER_TENANT, "j-b", branchingJourney());
    assert.deepEqual(await dispatchJourneyEvent(deps, leadEvent()), []);
    assert.equal(store.runs.size, 0);
  });

  it("never loads a contact from another workspace", async () => {
    store.saveJourney(OTHER_TENANT, "j-b", branchingJourney());
    const [outcome] = await dispatchJourneyEvent(deps, leadEvent(LEAD, OTHER_TENANT));
    assert.equal(outcome.result, "started");
    for (const call of actions.calls) {
      assert.equal(call.input.tenantId, OTHER_TENANT);
      assert.equal(call.input.lead, null);
    }
  });

  it("cancels runs whose journey is gone", async () => {
    store.saveJourney(TENANT, "j1", waitingJourney());
    const [outcome] = await dispatchJourneyEvent(deps, leadEvent());
    store.journeys.delete("j1");
    advance(3 * 24 * 60 * 60_000);
    const result = await executeRun(deps, outcome.runId!);
    assert.equal(result.status, "cancelled");
  });
});
