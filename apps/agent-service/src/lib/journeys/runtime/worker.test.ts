import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";
import type { JourneyAIExecutor } from "./ai.ts";
import { dispatchJourneyEvent, type ActionExecutor, type ActionInput, type EngineDeps } from "./engine.ts";
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
