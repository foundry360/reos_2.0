/**
 * Call-and-wait storage on PGlite with the real journey schema (migrations
 * 048, 054, 056, 058): the Supabase store's child lookup by run key and its
 * guarded wake-up, and the wake-up from the two cancellation paths outside the
 * engine (a member cancelling a run, archiving its journey).
 *
 * Fail-closed: the test env replaces fetch and sockets before any production
 * module loads, so nothing can reach a real Supabase project.
 */

import { attachTestDb, blockedRequests } from "./live-actions-test-env.ts";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { registerHooks } from "node:module";
import { after, before, beforeEach, describe, it } from "node:test";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createTestDb, type TestDb } from "./lead-status-test-db.ts";

const USER_CLIENT_MODULE = `data:text/javascript,${encodeURIComponent(
  "export async function createClient() { const client = globalThis.__reosTestUserClient; if (!client) throw new Error('No test user client'); return client; }",
)}`;
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "@/lib/supabase/server") return { url: USER_CLIENT_MODULE, shortCircuit: true };
    return nextResolve(specifier, context);
  },
});

const migration = (name: string) =>
  readFileSync(new URL(`../../../../../../supabase/migrations/${name}`, import.meta.url), "utf8");

const JOURNEY_SCHEMA = `
create schema auth;
create table auth.users (id uuid primary key);
create function public.set_updated_at() returns trigger language plpgsql as $$
begin new.updated_at = now(); return new; end $$;
drop table public.journey_runs cascade;
${migration("048_journeys.sql")}
${migration("054_journey_runtime.sql")}
${migration("056_journey_runs_one_active_run.sql")}
${migration("063_journey_runs_appointment_scope.sql")}
${migration("058_journey_archive.sql")}
`;

let db: TestDb;
let repo: typeof import("../journey-repository.ts");
let runRepo: typeof import("../journey-run-repository.ts");
let store: import("./engine.ts").JourneyRuntimeStore;
let tenant: string;
let otherTenant: string;
let member: string;

before(async () => {
  db = await createTestDb({ schema: JOURNEY_SCHEMA });
  attachTestDb(db);
  repo = await import("../journey-repository.ts");
  runRepo = await import("../journey-run-repository.ts");
  const { createSupabaseJourneyStore } = await import("./supabase-store.ts");
  store = createSupabaseJourneyStore(db.client("service_role"));
});

after(async () => {
  await db.pg.close();
  assert.deepEqual(blockedRequests, []);
});

beforeEach(async () => {
  await db.reset();
  const newTenant = async () => (await db.query<{ id: string }>("insert into public.tenants default values returning id"))[0].id;
  [tenant, otherTenant] = [await newTenant(), await newTenant()];
  member = randomUUID();
  await db.query("insert into auth.users (id) values ($1)", [member]);
  await db.query("insert into public.test_memberships (user_id, tenant_id) values ($1, $2)", [member, tenant]);
  (globalThis as { __reosTestUserClient?: SupabaseClient }).__reosTestUserClient = db.client("authenticated", member);
});

async function newJourney() {
  const trigger = randomUUID();
  const task = randomUUID();
  const created = await repo.createJourney({
    tenantId: tenant, userId: member, name: "Journey", description: "",
    graph: {
      nodes: [
        { id: trigger, type: "trigger", name: "Trigger", description: "", position: { x: 0, y: 0 }, config: { event: "manual", filters: [] } },
        { id: task, type: "action", name: "Task", description: "", position: { x: 0, y: 120 }, config: { action: "create_task", title: "Call", notes: "", dueInDays: 1 } },
      ],
      connections: [{ id: randomUUID(), sourceNodeId: trigger, targetNodeId: task, sourceHandle: null, targetHandle: null }],
    },
  });
  assert.ok(created.ok, created.ok ? "" : created.error);
  await db.query("update public.journeys set status = 'active' where id = $1", [created.value]);
  return created.value;
}

const LATER = "2030-01-01T00:00:00.000Z";

async function insertRun(input: {
  journeyId: string;
  status: string;
  key?: string;
  triggerEvent?: string;
  payload?: Record<string, unknown>;
  context?: Record<string, unknown>;
  id?: string;
}) {
  const [row] = await db.query<{ id: string }>(
    `insert into public.journey_runs
       (id, tenant_id, journey_id, journey_version, entity_type, status, trigger_event, trigger_payload, context, idempotency_key, resume_at)
     select $1, $2, j.id, j.version, 'contact', $3, $4, $5, $6, $7, $8 from public.journeys j where j.id = $9
     returning id`,
    [
      input.id ?? randomUUID(), tenant, input.status, input.triggerEvent ?? "manual",
      JSON.stringify(input.payload ?? {}), JSON.stringify(input.context ?? { steps: {} }), input.key ?? randomUUID(),
      input.status === "waiting" ? LATER : null, input.journeyId,
    ],
  );
  return row.id;
}

async function resumeAt(runId: string) {
  const [row] = await db.query<{ resume_at: Date | null }>("select resume_at from public.journey_runs where id = $1", [runId]);
  return row.resume_at?.toISOString() ?? null;
}

/** A parent waiting on a journey.started child it created, as the engine leaves them. */
async function waitingPair() {
  const parentJourney = await newJourney();
  const childJourney = await newJourney();
  const parentId = randomUUID();
  const childId = await insertRun({
    journeyId: childJourney, status: "waiting", triggerEvent: "journey.started",
    payload: { origin: "journey", origin_run_id: parentId, origin_journey_id: parentJourney, root_run_id: parentId, causation_depth: 1 },
  });
  await insertRun({
    id: parentId, journeyId: parentJourney, status: "waiting",
    context: { steps: {}, waitingForChild: { nodeId: "n0", stepId: randomUUID(), runId: childId } },
  });
  return { parentId, childId, childJourney };
}

describe("supabase store", () => {
  it("findRunByIdempotencyKey: the run's id and status, in this workspace only", async () => {
    const journey = await newJourney();
    const key = `journey.started:${randomUUID()}:node:${journey}`;
    const id = await insertRun({ journeyId: journey, status: "failed", key });

    assert.deepEqual(await store.findRunByIdempotencyKey(tenant, key), { id, status: "failed" });
    assert.equal(await store.findRunByIdempotencyKey(otherTenant, key), null);
    assert.equal(await store.findRunByIdempotencyKey(tenant, `${key}x`), null);
  });

  it("findRunByIdempotencyKey: a completed child's captured results (or why it has none), and nothing else of its context", async () => {
    const journey = await newJourney();
    const withResults = `journey.started:${randomUUID()}:node:${journey}`;
    const withError = `journey.started:${randomUUID()}:node:${journey}`;
    const resultsId = await insertRun({
      journeyId: journey, status: "completed", key: withResults,
      context: { steps: { ai: { output: { secret: "x" } } }, results: { decision: "approved", score: 0.92, ok: true, note: null } },
    });
    const errorId = await insertRun({
      journeyId: journey, status: "completed", key: withError,
      context: { steps: {}, resultsError: { reason: "results_too_large", bytes: 9001 } },
    });

    assert.deepEqual(await store.findRunByIdempotencyKey(tenant, withResults), {
      id: resultsId, status: "completed", results: { decision: "approved", score: 0.92, ok: true, note: null },
    });
    assert.deepEqual(await store.findRunByIdempotencyKey(tenant, withError), {
      id: errorId, status: "completed", resultsError: { reason: "results_too_large", bytes: 9001 },
    });
    assert.equal(await store.findRunByIdempotencyKey(otherTenant, withResults), null);
  });

  it("wakeWaitingParent: makes the parent due only for its own child, while waiting, in its workspace", async () => {
    const { parentId, childId } = await waitingPair();
    const now = new Date("2026-10-05T12:00:00.000Z");

    await store.wakeWaitingParent(tenant, parentId, randomUUID(), now);
    await store.wakeWaitingParent(otherTenant, parentId, childId, now);
    assert.equal(await resumeAt(parentId), LATER);

    await db.query("update public.journey_runs set status = 'paused' where id = $1", [parentId]);
    await store.wakeWaitingParent(tenant, parentId, childId, now);
    assert.equal(await resumeAt(parentId), LATER, "a parent that isn't waiting isn't touched");

    await db.query("update public.journey_runs set status = 'waiting' where id = $1", [parentId]);
    await store.wakeWaitingParent(tenant, parentId, childId, now);
    assert.equal(await resumeAt(parentId), now.toISOString());
  });
});

/** A parent waiting at a Start journeys step on two journey.started children it created. */
async function waitingFanOut() {
  const parentJourney = await newJourney();
  const [firstJourney, secondJourney] = [await newJourney(), await newJourney()];
  const parentId = randomUUID();
  const child = (journeyId: string) =>
    insertRun({
      journeyId, status: "waiting", triggerEvent: "journey.started",
      payload: { origin: "journey", origin_run_id: parentId, origin_journey_id: parentJourney, root_run_id: parentId, causation_depth: 1 },
    });
  const [first, second] = [await child(firstJourney), await child(secondJourney)];
  await insertRun({
    id: parentId, journeyId: parentJourney, status: "waiting",
    context: {
      steps: {},
      waitingForChildren: { nodeId: "n0", stepId: randomUUID(), children: [{ journeyId: firstJourney, runId: first }, { journeyId: secondJourney, runId: second }] },
    },
  });
  return { parentId, first, second, firstJourney };
}

describe("supabase store: Start journeys", () => {
  it("wakeWaitingParent: any one of the step's children makes the parent due; nothing else does", async () => {
    const { parentId, first, second } = await waitingFanOut();
    const { parentId: otherParent } = await waitingPair();
    const now = new Date("2026-10-05T12:00:00.000Z");

    await store.wakeWaitingParent(tenant, parentId, randomUUID(), now);
    await store.wakeWaitingParent(otherTenant, parentId, first, now);
    await store.wakeWaitingParent(tenant, otherParent, first, now);
    assert.equal(await resumeAt(parentId), LATER);
    assert.equal(await resumeAt(otherParent), LATER, "a child of another parent's step wakes only its own parent");

    await db.query("update public.journey_runs set status = 'paused' where id = $1", [parentId]);
    await store.wakeWaitingParent(tenant, parentId, second, now);
    assert.equal(await resumeAt(parentId), LATER, "a parent that isn't waiting isn't touched");

    await db.query("update public.journey_runs set status = 'waiting' where id = $1", [parentId]);
    await store.wakeWaitingParent(tenant, parentId, second, now);
    assert.equal(await resumeAt(parentId), now.toISOString());
  });

  it("a member cancelling one child, or archiving its journey, wakes the parent; the parent isn't cancelled", async () => {
    const cancelled = await waitingFanOut();
    assert.ok((await runRepo.cancelJourneyRun(tenant, cancelled.first)).ok);
    assert.ok(new Date((await resumeAt(cancelled.parentId))!).getTime() <= Date.now());

    const archived = await waitingFanOut();
    const result = await repo.setJourneyStatus({ tenantId: tenant, userId: null, journeyId: archived.firstJourney, status: "archived" });
    assert.ok(result.ok, result.ok ? "" : result.error);
    assert.ok(new Date((await resumeAt(archived.parentId))!).getTime() <= Date.now());
    const [parent] = await db.query<{ status: string }>("select status from public.journey_runs where id = $1", [archived.parentId]);
    assert.equal(parent.status, "waiting");
  });

  it("activation refuses a received result the started journey doesn't declare, and allows a declared one", async () => {
    const child = await newJourney();
    const childTrigger = (await db.query<{ id: string; config: Record<string, unknown> }>(
      "select id, config from public.journey_nodes where journey_id = $1 and type = 'trigger'", [child],
    ))[0];
    const declare = (results: unknown[]) =>
      db.query("update public.journey_nodes set config = $1 where id = $2", [JSON.stringify({ event: "journey.started", filters: [], results }), childTrigger.id]);
    await declare([]);

    const trigger = randomUUID();
    const fanOut = randomUUID();
    const created = await repo.createJourney({
      tenantId: tenant, userId: member, name: "Parent", description: "",
      graph: {
        nodes: [
          { id: trigger, type: "trigger", name: "Trigger", description: "", position: { x: 0, y: 0 }, config: { event: "manual", filters: [] } },
          {
            id: fanOut, type: "action", name: "Fan out", description: "", position: { x: 0, y: 120 },
            config: { action: "start_journeys", journeys: [{ journeyId: child, resultMappings: [{ target: "decision", source: "result.decision" }] }], waitForCompletion: true, completion: "all" },
          },
        ],
        connections: [{ id: randomUUID(), sourceNodeId: trigger, targetNodeId: fanOut, sourceHandle: null, targetHandle: null }],
      },
    });
    assert.ok(created.ok, created.ok ? "" : created.error);

    const refused = await repo.setJourneyStatus({ tenantId: tenant, userId: member, journeyId: created.value, status: "active" });
    assert.equal(refused.ok, false);
    assert.match(refused.ok ? "" : refused.error, /Journey 1: Result "decision": the started journey doesn't return "decision"\./);

    // A declared result whose source is the child's task step output.
    const task = (await db.query<{ id: string }>("select id from public.journey_nodes where journey_id = $1 and type = 'action'", [child]))[0];
    await declare([{ name: "decision", source: `steps.${task.id.replace(/-/g, "_")}.output.decision` }]);
    const activated = await repo.setJourneyStatus({ tenantId: tenant, userId: member, journeyId: created.value, status: "active" });
    assert.ok(activated.ok, activated.ok ? "" : activated.error);
  });
});

describe("cancellation outside the engine", () => {
  it("a member cancelling the child wakes the parent waiting for it", async () => {
    const { parentId, childId } = await waitingPair();

    const result = await runRepo.cancelJourneyRun(tenant, childId);

    assert.ok(result.ok);
    assert.ok(new Date((await resumeAt(parentId))!).getTime() <= Date.now());
    const [parent] = await db.query<{ status: string }>("select status from public.journey_runs where id = $1", [parentId]);
    assert.equal(parent.status, "waiting", "the parent itself isn't cancelled");
  });

  it("archiving the child's journey wakes the parent waiting for it", async () => {
    const { parentId, childJourney } = await waitingPair();

    const result = await repo.setJourneyStatus({ tenantId: tenant, userId: null, journeyId: childJourney, status: "archived" });

    assert.ok(result.ok, result.ok ? "" : result.error);
    assert.ok(new Date((await resumeAt(parentId))!).getTime() <= Date.now());
  });

  it("cancelling a run that nothing waits for, or a manual run, wakes nothing", async () => {
    const { parentId } = await waitingPair();
    const journey = await newJourney();
    const unrelated = await insertRun({
      journeyId: journey, status: "waiting", triggerEvent: "journey.started",
      payload: { origin: "journey", origin_run_id: parentId, causation_depth: 1 },
    });
    const manual = await insertRun({ journeyId: journey, status: "paused", payload: { origin_run_id: parentId } });
    const malformed = await insertRun({
      journeyId: await newJourney(), status: "waiting", triggerEvent: "journey.started", payload: { origin: "journey", origin_run_id: "not-a-run" },
    });
    const errors: unknown[] = [];
    const logError = console.error;
    console.error = (...args: unknown[]) => errors.push(args);

    try {
      assert.ok((await runRepo.cancelJourneyRun(tenant, unrelated)).ok);
      assert.ok((await runRepo.cancelJourneyRun(tenant, manual)).ok);
      assert.ok((await runRepo.cancelJourneyRun(tenant, malformed)).ok);
    } finally {
      console.error = logError;
    }

    assert.deepEqual(errors, [], "a malformed origin is skipped, not sent to the database");

    assert.equal(await resumeAt(parentId), LATER);
  });
});
