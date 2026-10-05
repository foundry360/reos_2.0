/**
 * One active run per (tenant, journey, contact): the runtime result when the
 * active-run index rejects an insert, and the real index (migration 056) on PGlite.
 */

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, beforeEach, describe, it } from "node:test";
import type { JourneyAIExecutor } from "./ai.ts";
import { dispatchJourneyEvent, type ActionExecutor, type EngineDeps, type JourneyEvent, type NewRun } from "./engine.ts";
import type { JourneySnapshot } from "./graph.ts";
import { createTestDb, type TestDb } from "./lead-status-test-db.ts";
import { MemoryJourneyStore } from "./memory-store.ts";
import { ACTIVE_RUN_INDEX, IDEMPOTENCY_CONSTRAINT, runInsertConflict } from "./run-insert-conflict.ts";

const TENANT = "tenant-a";
const OTHER_TENANT = "tenant-b";
const LEAD = "lead-1";

let store: MemoryJourneyStore;
let deps: EngineDeps;
let executed: string[];

const ai: JourneyAIExecutor = { execute: async () => ({ success: true, output: {}, text: "" }) };

beforeEach(() => {
  store = new MemoryJourneyStore();
  executed = [];
  const actions: ActionExecutor = {
    execute: async (_action, input) => {
      executed.push(input.runId);
      return { status: "completed", output: {} };
    },
  };
  deps = { store, actions, ai };
  for (const [tenantId, id] of [[TENANT, LEAD], [TENANT, "lead-2"], [OTHER_TENANT, LEAD]] as const) {
    store.contacts.set(`${tenantId}:${id}`, { tenantId, lead: { first_name: "Ana" } });
  }
});

/** Trigger → task → optional 1-day wait. With the wait the run stays active (waiting). */
function journey(journeyId: string, { waits = true, tenantId = TENANT } = {}) {
  const t = `${journeyId}-t`;
  const a = `${journeyId}-a`;
  const w = `${journeyId}-w`;
  const snapshot: JourneySnapshot = {
    nodes: [
      { id: t, type: "trigger", name: "Trigger", description: "", config: { event: "message.received", filters: [] } },
      { id: a, type: "action", name: "Task", description: "", config: { action: "create_task", title: "Reply", notes: "", dueInDays: 1 } },
      ...(waits ? [{ id: w, type: "action" as const, name: "Wait", description: "", config: { action: "wait", duration: 1, unit: "days" } }] : []),
    ],
    connections: [
      { id: `${journeyId}-c1`, sourceNodeId: t, targetNodeId: a, sourceHandle: null, targetHandle: null },
      ...(waits ? [{ id: `${journeyId}-c2`, sourceNodeId: a, targetNodeId: w, sourceHandle: null, targetHandle: null }] : []),
    ],
  };
  store.saveJourney(tenantId, journeyId, snapshot);
}

/** An inbound message: each one is a different event (its own sourceId, so its own idempotency key). */
function message(messageId: string, contact = LEAD, tenantId = TENANT): JourneyEvent {
  const contactId = `${tenantId}:${contact}`;
  return { tenantId, type: "message.received", sourceId: messageId, contactId, entityType: "message", entityId: messageId, payload: {} };
}

function newRun(overrides: Partial<NewRun> = {}): NewRun {
  return {
    tenantId: TENANT,
    journeyId: "j",
    journeyVersion: 1,
    contactId: `${TENANT}:${LEAD}`,
    entityType: "message",
    entityId: null,
    currentNodeId: "j-t",
    triggerEvent: "message.received",
    triggerPayload: {},
    idempotencyKey: `message.received:${randomUUID()}:j:v1`,
    resumeAt: new Date().toISOString(),
    ...overrides,
  };
}

const results = async (event: JourneyEvent, engine = deps) => (await dispatchJourneyEvent(engine, event)).map((outcome) => outcome.result);
const runs = () => [...store.runs.values()];
const active = () => runs().filter((run) => ["running", "waiting", "paused"].includes(run.status));

/** The check before the insert saw no active run (another worker's insert landed after it). */
function staleCheck(): EngineDeps {
  const stale = new Proxy(store, {
    get(target, property) {
      if (property === "hasActiveRun") return async () => false;
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  return { ...deps, store: stale };
}

describe("one active run per journey and contact (runtime)", () => {
  it("a second event while the run is active is already_active, through the check or the insert", async () => {
    journey("j");
    assert.deepEqual(await results(message("m1")), ["started"]);
    assert.equal(active().length, 1);
    assert.equal(active()[0].status, "waiting");

    assert.deepEqual(await results(message("m2")), ["already_active"]);
    assert.deepEqual(await store.createRun(newRun()), { run: null, created: false, alreadyActive: true });
    assert.equal(runs().length, 1);
  });

  it("an active-run conflict at insert time returns already_active and runs nothing", async () => {
    journey("j");
    await results(message("m1"));
    const before = executed.length;

    assert.deepEqual(await results(message("m2"), staleCheck()), ["already_active"]);
    assert.equal(executed.length, before, "the losing event executes no step");
    assert.equal(runs().length, 1);
  });

  it("a different journey for the same contact runs alongside", async () => {
    journey("j1");
    journey("j2");
    assert.deepEqual((await results(message("m1"))).sort(), ["started", "started"]);
    assert.deepEqual(active().map((run) => run.journeyId).sort(), ["j1", "j2"]);
  });

  it("a different contact in the same journey runs alongside", async () => {
    journey("j");
    assert.deepEqual(await results(message("m1", LEAD)), ["started"]);
    assert.deepEqual(await results(message("m2", "lead-2")), ["started"]);
    assert.equal(active().length, 2);
  });

  it("the same journey and contact ids in another workspace are independent", async () => {
    journey("j");
    await results(message("m1"));
    const sameIds = newRun({ tenantId: OTHER_TENANT, contactId: `${TENANT}:${LEAD}` });
    assert.equal((await store.createRun(sameIds)).created, true);
    assert.equal(active().length, 2);
  });

  it("a finished run doesn't block a new one: the rule is one active run, not one run ever", async () => {
    journey("j", { waits: false });
    assert.deepEqual(await results(message("m1")), ["started"]);
    assert.equal(runs()[0].status, "completed");
    assert.deepEqual(await results(message("m2")), ["started"]);
    assert.deepEqual(runs().map((run) => run.status), ["completed", "completed"]);

    for (const status of ["failed", "cancelled"] as const) {
      [...store.runs.values()].forEach((run) => (run.status = status));
      assert.equal((await store.createRun(newRun({ journeyId: "j" }))).created, true);
      [...store.runs.values()].forEach((run) => (run.status = status));
    }
  });

  it("a waiting run blocks another run", async () => {
    journey("j");
    await results(message("m1"));
    assert.equal(runs()[0].status, "waiting");
    assert.equal((await store.createRun(newRun())).alreadyActive, true);
    assert.deepEqual(await results(message("m2"), staleCheck()), ["already_active"]);
  });

  it("a paused run blocks another run", async () => {
    journey("j");
    await results(message("m1"));
    runs()[0].status = "paused";
    assert.equal((await store.createRun(newRun())).alreadyActive, true);
    assert.deepEqual(await results(message("m2")), ["already_active"]);
    assert.deepEqual(await results(message("m3"), staleCheck()), ["already_active"]);
    assert.equal(runs().length, 1);
  });

  it("the same event stays a duplicate, not already_active, even while its run is active", async () => {
    journey("j", { waits: false });
    await results(message("m1"));
    assert.deepEqual(await results(message("m1")), ["duplicate"]);

    store.setStatus("j", "paused");
    journey("k");
    await results(message("m9"));
    const k = runs().find((run) => run.journeyId === "k")!;
    assert.equal(k.status, "waiting");
    const again = await store.createRun(newRun({ journeyId: "k", idempotencyKey: k.idempotencyKey }));
    assert.equal(again.alreadyActive, undefined);
    assert.equal(again.created, false);
    assert.equal(again.run?.id, k.id);
    assert.deepEqual(await results(message("m9"), staleCheck()), ["duplicate"]);
  });

  it("two different events at the same moment: one started, one already_active, one active run", async () => {
    journey("j");
    const outcomes = await Promise.all([dispatchJourneyEvent(deps, message("m1")), dispatchJourneyEvent(deps, message("m2"))]);
    assert.deepEqual(outcomes.flat().map((outcome) => outcome.result).sort(), ["already_active", "started"]);
    assert.equal(runs().length, 1);
    assert.equal(active().length, 1);
    assert.deepEqual(executed, [runs()[0].id], "only the winning run executed its step");
  });

  it("a contactless run is never blocked", async () => {
    assert.equal((await store.createRun(newRun({ contactId: null }))).created, true);
    assert.equal((await store.createRun(newRun({ contactId: null }))).created, true);
  });
});

describe("runInsertConflict", () => {
  it("names the rule from the PostgREST error", () => {
    assert.equal(
      runInsertConflict({ code: "23505", message: `duplicate key value violates unique constraint "${ACTIVE_RUN_INDEX}"`, details: null }),
      "active_run",
    );
    assert.equal(
      runInsertConflict({ code: "23505", message: `duplicate key value violates unique constraint "${IDEMPOTENCY_CONSTRAINT}"`, details: null }),
      "idempotency",
    );
    assert.equal(runInsertConflict({ code: "23505", message: "", details: "Key (tenant_id, journey_id, contact_id)=(a, b, c) already exists." }), "active_run");
    assert.equal(runInsertConflict({ code: "23505", message: "", details: "Key (tenant_id, idempotency_key)=(a, k) already exists." }), "idempotency");
  });

  it("anything else is not a known run conflict", () => {
    assert.equal(runInsertConflict({ code: "23505", message: 'duplicate key value violates unique constraint "journey_runs_pkey"', details: "Key (id)=(x) already exists." }), null);
    assert.equal(runInsertConflict({ code: "23503", message: ACTIVE_RUN_INDEX, details: null }), null);
    assert.equal(runInsertConflict(null), null);
  });
});

describe("journey_runs_one_active_per_contact_idx in Postgres (migration 056)", () => {
  let db: TestDb;
  let tenant: string;
  let contact: string;

  before(async () => {
    db = await createTestDb();
  });

  after(async () => {
    await db.pg.close();
  });

  beforeEach(async () => {
    await db.reset();
    tenant = await newTenant();
    contact = await newContact(tenant);
  });

  async function newTenant() {
    const [row] = await db.query<{ id: string }>("insert into public.tenants default values returning id");
    return row.id;
  }

  async function newContact(tenantId: string) {
    const [row] = await db.query<{ id: string }>("insert into public.contacts (tenant_id) values ($1) returning id", [tenantId]);
    return row.id;
  }

  function insert(run: { tenantId?: string; journeyId: string; contactId?: string | null; status?: string; key?: string }) {
    return db.query(
      "insert into public.journey_runs (tenant_id, journey_id, contact_id, status, idempotency_key) values ($1, $2, $3, $4, $5)",
      [run.tenantId ?? tenant, run.journeyId, run.contactId === undefined ? contact : run.contactId, run.status ?? "running", run.key ?? randomUUID()],
    );
  }

  /** The conflict as PostgREST would report it (constraint name in message, key columns in details). */
  async function conflictOf(work: Promise<unknown>) {
    try {
      await work;
    } catch (error) {
      const pg = error as { code?: string; message?: string; detail?: string };
      return { code: pg.code, rule: runInsertConflict({ code: pg.code, message: pg.message, details: pg.detail }) };
    }
    return null;
  }

  it("a second active run with a different key is rejected by the active-run index", async () => {
    const journey = randomUUID();
    await insert({ journeyId: journey, key: "event-1" });
    assert.deepEqual(await conflictOf(insert({ journeyId: journey, key: "event-2" })), { code: "23505", rule: "active_run" });
  });

  it("waiting and paused runs block; completed, failed, and cancelled runs don't", async () => {
    for (const status of ["waiting", "paused"]) {
      const journey = randomUUID();
      await insert({ journeyId: journey, status });
      assert.deepEqual(await conflictOf(insert({ journeyId: journey })), { code: "23505", rule: "active_run" }, status);
    }
    for (const status of ["completed", "failed", "cancelled"]) {
      const journey = randomUUID();
      await insert({ journeyId: journey, status });
      await insert({ journeyId: journey, status });
      assert.equal(await conflictOf(insert({ journeyId: journey })), null, status);
    }
  });

  it("different journeys, contacts, and workspaces are independent; contactless runs are never blocked", async () => {
    const journey = randomUUID();
    await insert({ journeyId: journey });
    await insert({ journeyId: randomUUID() });
    await insert({ journeyId: journey, contactId: await newContact(tenant) });
    await insert({ journeyId: journey, tenantId: await newTenant() });
    await insert({ journeyId: journey, contactId: null });
    await insert({ journeyId: journey, contactId: null });
  });

  it("the same idempotency key is still the idempotency conflict, even when the run is also active", async () => {
    const journey = randomUUID();
    await insert({ journeyId: journey, status: "completed", key: "done" });
    assert.deepEqual(await conflictOf(insert({ journeyId: journey, key: "done" })), { code: "23505", rule: "idempotency" });

    await insert({ journeyId: journey, key: "live" });
    assert.deepEqual(await conflictOf(insert({ journeyId: journey, key: "live" })), { code: "23505", rule: "idempotency" });
  });

  it("finishing the active run frees the slot", async () => {
    const journey = randomUUID();
    await insert({ journeyId: journey, key: "first" });
    await db.query("update public.journey_runs set status = 'completed' where idempotency_key = 'first'");
    await insert({ journeyId: journey, key: "second" });
  });
});
