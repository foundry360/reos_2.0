import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";
import type { JourneyAIExecutor } from "./ai.ts";
import {
  dispatchJourneyEvent,
  LEASE_MS,
  MAX_ATTEMPTS,
  RETRY_BACKOFF_MS,
  type ActionExecutor,
  type ActionInput,
  type EngineDeps,
} from "./engine.ts";
import type { JourneySnapshot, SnapshotNode } from "./graph.ts";
import { MemoryJourneyStore } from "./memory-store.ts";
import {
  authorizeCronRequest,
  DEFAULT_WORKER_OPTIONS,
  handleJourneyWorkerRequest,
  type WorkerOptions,
} from "./worker.ts";

const TENANT = "tenant-a";
const SECRET = "test-cron-secret-value";

function node(id: string, type: SnapshotNode["type"], name: string, config: Record<string, unknown>): SnapshotNode {
  return { id, type, name, description: "", config };
}

function link(source: string, target: string) {
  return { id: `${source}->${target}`, sourceNodeId: source, targetNodeId: target, sourceHandle: null, targetHandle: null };
}

/** Trigger → SMS */
function smsJourney(): JourneySnapshot {
  return {
    nodes: [
      node("t", "trigger", "New lead", { event: "lead.created", filters: [] }),
      node("s", "action", "Text", { action: "send_sms", body: "Hi" }),
    ],
    connections: [link("t", "s")],
  };
}

/** Trigger → Wait 1 hour → SMS */
function waitingJourney(): JourneySnapshot {
  return {
    nodes: [
      node("t", "trigger", "New lead", { event: "lead.created", filters: [] }),
      node("w", "action", "Wait", { action: "wait", duration: 1, unit: "hours" }),
      node("s", "action", "Text", { action: "send_sms", body: "Checking in" }),
    ],
    connections: [link("t", "w"), link("w", "s")],
  };
}

class RecordingActions implements ActionExecutor {
  calls: Array<{ action: string; contactId: string | null }> = [];
  onExecute?: (input: ActionInput) => Promise<void> | void;
  async execute(action: Parameters<ActionExecutor["execute"]>[0], input: ActionInput) {
    this.calls.push({ action: action.action, contactId: input.contactId });
    await this.onExecute?.(input);
    return { status: "completed" as const, output: { ok: true } };
  }
}

const noAI: JourneyAIExecutor = {
  async execute() {
    return { success: true, output: {}, text: "" };
  },
};

function headers(values: Record<string, string> = {}) {
  return new Headers(values);
}

let store: MemoryJourneyStore;
let actions: RecordingActions;
let clock: Date;
let deps: EngineDeps;
let logs: string[];

beforeEach(() => {
  store = new MemoryJourneyStore();
  actions = new RecordingActions();
  clock = new Date("2026-10-01T12:00:00Z");
  deps = { store, actions, ai: noAI, now: () => new Date(clock) };
  logs = [];
});

/** A due run that hasn't started yet (as left by a dispatch whose inline pass was cut off). */
async function dueRun(contactId: string, journeyId = "j1") {
  if (!store.journeys.has(journeyId)) store.saveJourney(TENANT, journeyId, smsJourney());
  store.contacts.set(contactId, { tenantId: TENANT, lead: { first_name: "Ana" } });
  const { run } = await store.createRun({
    tenantId: TENANT,
    journeyId,
    journeyVersion: 1,
    contactId,
    entityType: "contact",
    entityId: contactId,
    currentNodeId: "t",
    triggerEvent: "lead.created",
    triggerPayload: {},
    idempotencyKey: `${journeyId}:${contactId}`,
    resumeAt: clock.toISOString(),
  });
  if (!run) throw new Error("dueRun: the contact already has an active run of this journey");
  return run.id;
}

function invoke(requestHeaders: Headers = headers({ authorization: `Bearer ${SECRET}` }), options?: Partial<WorkerOptions>, workerClock?: () => number) {
  return handleJourneyWorkerRequest(requestHeaders, {
    cronSecret: SECRET,
    createDeps: () => deps,
    options: { ...DEFAULT_WORKER_OPTIONS, ...options },
    clock: workerClock,
    log: (message) => logs.push(message),
  });
}

describe("cron authentication", () => {
  it("accepts Authorization: Bearer (GET and POST share the handler)", async () => {
    const response = await invoke(headers({ authorization: `Bearer ${SECRET}` }));
    assert.equal(response.status, 200);
    assert.equal(response.body.ok, true);
  });

  it("accepts x-cron-secret (as sent by a pg_net POST)", async () => {
    const response = await invoke(headers({ "x-cron-secret": SECRET, "content-type": "application/json" }));
    assert.equal(response.status, 200);
  });

  it("treats the Bearer scheme case-insensitively", () => {
    assert.equal(authorizeCronRequest(headers({ authorization: `bearer ${SECRET}` }), SECRET), "ok");
  });

  it("rejects a missing or wrong secret without echoing it", async () => {
    for (const requestHeaders of [
      headers(),
      headers({ authorization: "Bearer wrong" }),
      headers({ "x-cron-secret": "wrong" }),
      headers({ authorization: SECRET }),
    ]) {
      const response = await invoke(requestHeaders);
      assert.equal(response.status, 401);
      assert.ok(!JSON.stringify(response.body).includes(SECRET));
    }
    assert.deepEqual(logs, []);
  });

  it("refuses to run when no secret is configured", async () => {
    for (const cronSecret of [undefined, "", "   "]) {
      const response = await handleJourneyWorkerRequest(headers({ authorization: "Bearer " }), {
        cronSecret,
        createDeps: () => deps,
      });
      assert.equal(response.status, 501);
    }
  });

  it("doesn't touch the database before authenticating", async () => {
    let created = false;
    const response = await handleJourneyWorkerRequest(headers(), {
      cronSecret: SECRET,
      createDeps: () => {
        created = true;
        return deps;
      },
    });
    assert.equal(response.status, 401);
    assert.equal(created, false);
  });
});

describe("worker pass", () => {
  it("returns promptly and quietly when nothing is due", async () => {
    const response = await invoke();
    assert.equal(response.status, 200);
    assert.equal(response.body.found, 0);
    assert.equal(response.body.claimed, 0);
    assert.equal(response.body.batches, 1);
    assert.deepEqual(logs, [], "idle minute-level invocations don't log");
  });

  it("claims and executes a due run, and logs a summary without lead data", async () => {
    const runId = await dueRun("contact-1");
    const response = await invoke();

    assert.equal(response.status, 200);
    assert.equal(response.body.found, 1);
    assert.equal(response.body.claimed, 1);
    assert.deepEqual(response.body.statuses, { completed: 1 });
    assert.deepEqual(actions.calls, [{ action: "send_sms", contactId: "contact-1" }]);
    assert.equal(store.runs.get(runId)!.status, "completed");
    assert.equal(logs.length, 1);
    assert.match(logs[0], /^Journey worker: /);
    assert.ok(!logs[0].includes("Ana") && !logs[0].includes("contact-1") && !logs[0].includes(SECRET));
  });

  it("executes each run once when invocations overlap", async () => {
    const ids = await Promise.all(["c1", "c2", "c3"].map((contact) => dueRun(contact)));
    // Yield inside each action so the two invocations interleave.
    actions.onExecute = () => new Promise((resolve) => setImmediate(resolve));

    const [a, b] = await Promise.all([invoke(), invoke(headers({ "x-cron-secret": SECRET }))]);

    assert.equal(a.status, 200);
    assert.equal(b.status, 200);
    assert.equal(actions.calls.length, 3, "one SMS per run");
    assert.deepEqual(actions.calls.map((call) => call.contactId).sort(), ["c1", "c2", "c3"]);
    assert.equal(Number(a.body.found), 3, "both invocations listed every due run");
    assert.equal(Number(b.body.found), 3);
    assert.equal(Number(a.body.claimed) + Number(b.body.claimed), 3);
    assert.equal(Number(a.body.skipped) + Number(b.body.skipped), 3, "the loser of each claim skipped it");
    for (const id of ids) assert.equal(store.runs.get(id)!.status, "completed");
  });

  it("keeps going when one run throws", async () => {
    store.saveJourney(TENANT, "broken", smsJourney());
    const broken = await dueRun("c1", "broken");
    const healthy = await dueRun("c2");
    const loadSnapshot = store.loadSnapshot.bind(store);
    store.loadSnapshot = async (journeyId, version) => {
      if (journeyId === "broken") throw new Error("connection reset");
      return loadSnapshot(journeyId, version);
    };

    const response = await invoke();

    assert.equal(response.status, 200, "a single run failure isn't an invocation failure");
    assert.equal(response.body.errors, 1);
    assert.equal(response.body.claimed, 1);
    assert.equal(store.runs.get(healthy)!.status, "completed");
    assert.deepEqual(actions.calls, [{ action: "send_sms", contactId: "c2" }]);
    assert.equal(store.runs.get(broken)!.status, "running", "left for lease expiry and the next pass");
  });

  it("returns 500 without details when the due-run query fails", async () => {
    store.listDueRunIds = async () => {
      throw new Error("permission denied for table journey_runs");
    };
    const response = await invoke();
    assert.equal(response.status, 500);
    assert.deepEqual(response.body, { error: "Journey worker failed." });
    assert.equal(logs.length, 1);
    assert.ok(!logs[0].includes(SECRET));
  });

  it("returns 503 when the database client isn't configured", async () => {
    const response = await handleJourneyWorkerRequest(headers({ authorization: `Bearer ${SECRET}` }), {
      cronSecret: SECRET,
      createDeps: () => null,
      log: (message) => logs.push(message),
    });
    assert.equal(response.status, 503);
  });

  it("stops starting runs once the time budget is spent and leaves the rest due", async () => {
    const ids = await Promise.all(["c1", "c2", "c3"].map((contact) => dueRun(contact)));
    let elapsed = 0;
    actions.onExecute = () => {
      elapsed += 30_000;
    };

    const response = await invoke(undefined, { budgetMs: 50_000 }, () => elapsed);

    assert.equal(response.body.claimed, 2, "runs started at 0s and 30s; none at 60s");
    assert.equal(response.body.budgetReached, true);
    assert.equal(store.runs.get(ids[2])!.status, "running");
    assert.deepEqual(await store.listDueRunIds(clock, 25), [ids[2]], "the next invocation picks it up");
  });

  it("drains more than one batch, then stops when a batch comes back short", async () => {
    await Promise.all(["c1", "c2", "c3", "c4", "c5"].map((contact) => dueRun(contact)));
    const response = await invoke(undefined, { batchSize: 2 });
    assert.equal(response.body.claimed, 5);
    assert.equal(response.body.batches, 3);
  });

  it("doesn't resume a wait early and resumes it once due", async () => {
    store.saveJourney(TENANT, "j1", waitingJourney());
    store.contacts.set("contact-1", { tenantId: TENANT, lead: {} });
    await dispatchJourneyEvent(deps, {
      tenantId: TENANT,
      type: "lead.created",
      sourceId: "contact-1",
      contactId: "contact-1",
      entityType: "contact",
      entityId: "contact-1",
      payload: {},
    });
    const run = () => [...store.runs.values()][0];
    assert.equal(run().status, "waiting");

    clock = new Date(clock.getTime() + 30 * 60_000);
    assert.equal((await invoke()).body.found, 0);
    assert.equal(actions.calls.length, 0);

    clock = new Date(clock.getTime() + 31 * 60_000);
    const response = await invoke();
    assert.equal(response.body.claimed, 1);
    assert.equal(run().status, "completed");
    assert.deepEqual(actions.calls.map((call) => call.action), ["send_sms"]);
  });
});

/**
 * The production path end to end: the event emitter's dispatchJourneyEvent
 * starts and runs the journey inline until the wait, and the cron route's
 * worker handler resumes it when due. Only the CRM/SMS executor is a stand-in.
 */
describe("canonical journey: trigger → task → wait → SMS → completed", () => {
  const CONTACT = "contact-1";
  const JOURNEY = "j-new-lead";

  /** Trigger (new lead) → Create task → Wait 1 day → Text */
  function newLeadFollowUp(secondAction: SnapshotNode["config"] = { action: "send_sms", body: "Checking in" }): JourneySnapshot {
    return {
      nodes: [
        node("t", "trigger", "New lead", { event: "lead.created", filters: [] }),
        node("task", "action", "Call task", { action: "create_task", title: "Call the new lead", notes: "", dueInDays: 1 }),
        node("w", "action", "Wait", { action: "wait", duration: 1, unit: "days" }),
        node("sms", "action", "Text", secondAction),
      ],
      connections: [link("t", "task"), link("task", "w"), link("w", "sms")],
    };
  }

  const leadCreated = (sourceId = CONTACT) => ({
    tenantId: TENANT,
    type: "lead.created" as const,
    sourceId,
    contactId: CONTACT,
    entityType: "contact",
    entityId: CONTACT,
    payload: {},
  });

  let executed: Array<{ action: string; runId: string; nodeId: string; contactId: string | null }>;

  beforeEach(() => {
    store.contacts.set(CONTACT, { tenantId: TENANT, lead: { first_name: "Ana", record_type: "lead" } });
    store.saveJourney(TENANT, JOURNEY, newLeadFollowUp());
    // Same event, but its filter doesn't match this lead.
    store.saveJourney(TENANT, "j-filtered", {
      nodes: [
        node("ft", "trigger", "New lead named Bob", { event: "lead.created", filters: [{ field: "lead.first_name", operator: "equals", value: "Bob" }] }),
        node("fs", "action", "Text", { action: "send_sms", body: "Hi Bob" }),
      ],
      connections: [link("ft", "fs")],
    });
    // Listens for a different event.
    store.saveJourney(TENANT, "j-other-event", {
      nodes: [
        node("ot", "trigger", "Reply", { event: "message.received", filters: [] }),
        node("os", "action", "Text", { action: "send_sms", body: "Thanks" }),
      ],
      connections: [link("ot", "os")],
    });
    executed = [];
    const record = actions.execute.bind(actions);
    actions.execute = async (action, input) => {
      executed.push({ action: action.action, runId: input.runId, nodeId: input.nodeId, contactId: input.contactId });
      return record(action, input);
    };
  });

  it("starts once, waits, resumes the same run, runs each action once, and completes", async () => {
    // Trigger: only the intended journey starts, for this contact, exactly once.
    const outcomes = await dispatchJourneyEvent(deps, leadCreated());
    assert.deepEqual(
      outcomes.map(({ journeyId, result }) => ({ journeyId, result })),
      [
        { journeyId: JOURNEY, result: "started" },
        { journeyId: "j-filtered", result: "filtered" },
      ],
    );
    assert.equal(store.runs.size, 1);
    const runId = outcomes[0].runId!;
    const run = () => store.runs.get(runId)!;
    assert.equal(run().journeyId, JOURNEY);
    assert.equal(run().contactId, CONTACT);
    assert.equal(run().journeyVersion, 1);
    assert.equal(run().idempotencyKey, `lead.created:${CONTACT}:${JOURNEY}`);

    // First action ran inline, once, and its step is recorded as completed.
    assert.deepEqual(executed, [{ action: "create_task", runId, nodeId: "task", contactId: CONTACT }]);
    const steps = () => store.stepsFor(runId).map(({ nodeId, status, attemptCount }) => ({ nodeId, status, attemptCount }));
    assert.deepEqual(steps(), [
      { nodeId: "t", status: "completed", attemptCount: undefined },
      { nodeId: "task", status: "completed", attemptCount: 1 },
      { nodeId: "w", status: "running", attemptCount: undefined },
    ]);

    // Wait: the run is parked on the wait step, not completed, and released for the worker.
    const resumeAt = new Date(clock.getTime() + 24 * 60 * 60_000).toISOString();
    assert.equal(outcomes[0].execution?.status, "waiting");
    assert.equal(run().status, "waiting");
    assert.equal(run().currentNodeId, "w");
    assert.equal(run().resumeAt, resumeAt);
    assert.equal(run().completedAt, null);
    assert.equal(run().lockedUntil, null);
    assert.equal(run().context.inFlight, undefined);
    assert.equal(run().context.waitingStepId, store.stepsFor(runId)[2].id);

    // While waiting: the active run blocks a redelivery and any other start for the contact,
    // including under a newer journey version, which doesn't touch the pinned run.
    assert.deepEqual((await dispatchJourneyEvent(deps, leadCreated())).map((outcome) => outcome.result), ["already_active", "filtered"]);
    store.saveJourney(TENANT, JOURNEY, newLeadFollowUp({ action: "send_email", subject: "Hi", body: "v2" }));
    assert.deepEqual((await dispatchJourneyEvent(deps, leadCreated())).map((outcome) => outcome.result), ["already_active", "filtered"]);
    assert.equal(store.runs.size, 1);
    assert.equal(executed.length, 1);

    // Not due yet: the worker finds nothing and the second action doesn't run.
    clock = new Date(clock.getTime() + 23 * 60 * 60_000);
    assert.equal((await invoke()).body.found, 0);
    assert.equal(run().status, "waiting");
    assert.equal(executed.length, 1);

    // Resume through the cron worker: same run, first action not repeated, second action once (from v1).
    clock = new Date(clock.getTime() + 61 * 60_000);
    const response = await invoke();
    assert.equal(response.status, 200);
    assert.equal(response.body.found, 1);
    assert.equal(response.body.claimed, 1);
    assert.deepEqual(response.body.statuses, { completed: 1 });
    assert.equal(store.runs.size, 1);
    assert.deepEqual(executed, [
      { action: "create_task", runId, nodeId: "task", contactId: CONTACT },
      { action: "send_sms", runId, nodeId: "sms", contactId: CONTACT },
    ]);

    // Completion.
    assert.equal(run().status, "completed");
    assert.equal(run().currentNodeId, null);
    assert.equal(run().resumeAt, null);
    assert.equal(run().lockedUntil, null);
    assert.equal(run().error, null);
    assert.ok(run().completedAt);
    assert.deepEqual(steps(), [
      { nodeId: "t", status: "completed", attemptCount: undefined },
      { nodeId: "task", status: "completed", attemptCount: 1 },
      { nodeId: "w", status: "completed", attemptCount: undefined },
      { nodeId: "sms", status: "completed", attemptCount: 1 },
    ]);
    assert.deepEqual(Object.keys(run().context.steps), ["new_lead", "call_task", "wait", "text"]);

    // A later worker pass has nothing to do.
    assert.equal((await invoke()).body.found, 0);
    assert.equal(executed.length, 2);
  });

  it("a redelivered trigger after completion is a duplicate, not a second run", async () => {
    await dispatchJourneyEvent(deps, leadCreated());
    clock = new Date(clock.getTime() + 24 * 60 * 60_000);
    await invoke();
    assert.equal([...store.runs.values()][0].status, "completed");

    const redelivered = await dispatchJourneyEvent(deps, leadCreated());
    assert.deepEqual(redelivered.map((outcome) => outcome.result), ["duplicate", "filtered"]);
    assert.equal(store.runs.size, 1);
    assert.deepEqual(executed.map((call) => call.action), ["create_task", "send_sms"]);
  });

  describe("an SMS that was sent is never sent again because recording it failed", () => {
    const smsSends = () => executed.filter((call) => call.action === "send_sms").length;
    const theRun = () => [...store.runs.values()][0];
    const smsSteps = () => store.steps.filter((step) => step.nodeId === "sms");

    /** Fails the first SMS step success write. */
    function failSmsStepRecordingOnce() {
      const updateStep = store.updateStep.bind(store);
      let pending = true;
      store.updateStep = async (stepId, patch) => {
        const step = store.steps.find((entry) => entry.id === stepId);
        if (pending && step?.nodeId === "sms" && patch.status === "completed") {
          pending = false;
          throw new Error("connection reset");
        }
        return updateStep(stepId, patch);
      };
    }

    /** Fails the first run write after the SMS went out. */
    function failRunWriteAfterSmsOnce() {
      const updateRun = store.updateRun.bind(store);
      let pending = true;
      store.updateRun = async (runId, lease, patch) => {
        if (pending && smsSends() > 0) {
          pending = false;
          throw new Error("connection reset");
        }
        return updateRun(runId, lease, patch);
      };
    }

    /** Starts the journey, then runs the worker when the wait ends. */
    async function reachTheSms() {
      await dispatchJourneyEvent(deps, leadCreated());
      clock = new Date(clock.getTime() + 24 * 60 * 60_000);
      return invoke();
    }

    /** A later worker pass, after the bookkeeping-failed pass's lease expired. */
    async function nextPass() {
      clock = new Date(clock.getTime() + LEASE_MS + 60_000);
      return invoke();
    }

    it("recovers when the SMS step's success can't be recorded", async () => {
      failSmsStepRecordingOnce();

      const failedPass = await reachTheSms();
      assert.equal(failedPass.body.errors, 1, "the bookkeeping failure surfaces as an error");
      assert.equal(smsSends(), 1);
      assert.equal(theRun().status, "running");
      assert.equal(theRun().context.inFlight?.outcome?.status, "completed", "the outcome is kept on the run");
      assert.equal(smsSteps()[0].status, "running");

      const recovery = await nextPass();
      assert.deepEqual(recovery.body.statuses, { completed: 1 });
      assert.equal(smsSends(), 1, "the SMS isn't sent again");
      assert.equal(theRun().status, "completed");
      assert.equal(theRun().context.inFlight, undefined);
      assert.deepEqual(smsSteps().map(({ status, attemptCount }) => ({ status, attemptCount })), [{ status: "completed", attemptCount: 1 }]);
      assert.deepEqual(smsSteps()[0].output, { ok: true });
      assert.deepEqual(theRun().context.steps.text, { output: { ok: true } });
    });

    it("recovers when the run can't be advanced after the SMS step was recorded", async () => {
      failRunWriteAfterSmsOnce();

      const failedPass = await reachTheSms();
      assert.equal(failedPass.body.errors, 1);
      assert.equal(smsSends(), 1);
      assert.equal(smsSteps()[0].status, "completed");
      assert.equal(theRun().currentNodeId, "sms");
      assert.ok(theRun().context.inFlight);

      const recovery = await nextPass();
      assert.deepEqual(recovery.body.statuses, { completed: 1 });
      assert.equal(smsSends(), 1, "the SMS isn't sent again");
      assert.equal(theRun().status, "completed");
      assert.deepEqual(smsSteps().map(({ status }) => status), ["completed"]);
      assert.deepEqual(theRun().context.steps.text, { output: { ok: true } });
    });

    it("if neither the step nor the run can record the send, it still isn't sent again", async () => {
      failSmsStepRecordingOnce();
      failRunWriteAfterSmsOnce();

      await reachTheSms();
      assert.equal(smsSends(), 1);

      await nextPass();
      assert.equal(smsSends(), 1, "an unknown outcome isn't retried (existing interrupted-step rule)");
      assert.equal(theRun().status, "failed");
      assert.match(theRun().error ?? "", /interrupted/);
    });
  });

  describe("an SMS that actually failed is still retried", () => {
    const smsAttempts = () => executed.filter((call) => call.action === "send_sms").length;
    const theRun = () => [...store.runs.values()][0];

    it("retries a transient provider failure and completes", async () => {
      actions.onExecute = (input) => {
        if (input.nodeId === "sms" && smsAttempts() === 1) throw new Error("provider timeout");
      };
      await dispatchJourneyEvent(deps, leadCreated());
      clock = new Date(clock.getTime() + 24 * 60 * 60_000);
      await invoke();
      assert.equal(smsAttempts(), 1);
      assert.equal(theRun().status, "waiting");
      assert.equal(theRun().resumeAt, new Date(clock.getTime() + RETRY_BACKOFF_MS[0]).toISOString());

      clock = new Date(clock.getTime() + RETRY_BACKOFF_MS[0]);
      await invoke();
      assert.equal(smsAttempts(), 2, "the failed send is attempted again");
      assert.equal(theRun().status, "completed");
      assert.deepEqual(
        store.steps.filter((step) => step.nodeId === "sms").map(({ status, attemptCount, errorKind }) => ({ status, attemptCount, errorKind })),
        [
          { status: "failed", attemptCount: 1, errorKind: "transient" },
          { status: "completed", attemptCount: 2, errorKind: undefined },
        ],
      );
    });

    it("stops after the existing maximum number of attempts", async () => {
      actions.onExecute = (input) => {
        if (input.nodeId === "sms") throw new Error("provider timeout");
      };
      await dispatchJourneyEvent(deps, leadCreated());
      clock = new Date(clock.getTime() + 24 * 60 * 60_000);
      for (let pass = 0; pass < MAX_ATTEMPTS + 2; pass++) {
        await invoke();
        clock = new Date(clock.getTime() + 31 * 60_000);
      }
      assert.equal(smsAttempts(), MAX_ATTEMPTS);
      assert.equal(theRun().status, "failed");
      assert.equal(theRun().error, "provider timeout");
    });
  });
});
