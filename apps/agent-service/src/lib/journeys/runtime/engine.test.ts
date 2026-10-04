import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";
import { createAIStepRouter } from "./ai.ts";
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
let clock: Date;
let deps: EngineDeps;

beforeEach(() => {
  store = new MemoryJourneyStore();
  actions = new RecordingActions();
  clock = new Date("2026-10-01T12:00:00Z");
  deps = { store, actions, ai: createAIStepRouter(), now: () => new Date(clock) };
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

describe("AI steps", () => {
  it("records a skipped step when no agent is configured and continues", async () => {
    store.saveJourney(TENANT, "j1", {
      nodes: [
        node("t", "trigger", "New lead", { event: "lead.created", filters: [] }),
        node("ai", "ai", "Qualify", { goal: "Qualify", instructions: "", agent: "default" }),
        node("s", "action", "Text", { action: "send_sms", body: "Hi" }),
      ],
      connections: [link("t", "ai"), link("ai", "s")],
    });
    const [outcome] = await dispatchJourneyEvent(deps, leadEvent());
    assert.equal(outcome.execution?.status, "completed");
    assert.equal(store.stepsFor(outcome.runId!).find((s) => s.nodeId === "ai")?.status, "skipped");
    assert.deepEqual(actions.names(), ["send_sms"]);
  });

  it("routes to a registered agent by key", async () => {
    deps.ai = createAIStepRouter({
      qualifier: { run: async () => ({ status: "completed", output: { score: 88 } }) },
    });
    store.saveJourney(TENANT, "j1", {
      nodes: [
        node("t", "trigger", "New lead", { event: "lead.created", filters: [] }),
        node("ai", "ai", "Qualify", { goal: "Qualify", instructions: "", agent: "qualifier" }),
        node("c", "condition", "High score", { field: "steps.qualify.output.score", operator: "greater_than", value: 80 }),
        node("s", "action", "Text", { action: "send_sms", body: "Hi" }),
      ],
      connections: [link("t", "ai"), link("ai", "c"), link("c", "s", "yes")],
    });
    await dispatchJourneyEvent(deps, leadEvent());
    assert.deepEqual(actions.names(), ["send_sms"]);
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
