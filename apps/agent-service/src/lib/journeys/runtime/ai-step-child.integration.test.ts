/**
 * One child per AI step (migration 059) on PGlite with the real journey schema
 * (migrations 048, 054, 056, 058, 059), through the Supabase store's createRun:
 * of two children an AI step asked for (same parent run and node), whatever
 * journeys they are for, only the first insert succeeds. Start journey and
 * Start journeys children are unaffected.
 *
 * Fail-closed: the test env replaces fetch and sockets before any production
 * module loads, so nothing can reach a real Supabase project.
 */

import { blockedRequests } from "./live-actions-test-env.ts";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { after, before, beforeEach, describe, it } from "node:test";
import type { JourneyRuntimeStore, NewRun } from "./engine.ts";
import { createTestDb, type TestDb } from "./lead-status-test-db.ts";
import { AI_STEP_CHILD_INDEX } from "./run-insert-conflict.ts";

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
${migration("058_journey_archive.sql")}
${migration("059_journey_runs_one_child_per_ai_step.sql")}
`;

let db: TestDb;
let store: JourneyRuntimeStore;
let tenant: string;
let otherTenant: string;

before(async () => {
  db = await createTestDb({ schema: JOURNEY_SCHEMA });
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
});

async function newJourney(tenantId = tenant) {
  const [{ id }] = await db.query<{ id: string }>(
    "insert into public.journeys (tenant_id, name, status) values ($1, 'Journey', 'active') returning id",
    [tenantId],
  );
  await db.query("select public.snapshot_journey_version($1)", [id]);
  return id;
}

/** A child a step of `parentRunId` (node `nodeId`) starts for `journeyId`, exactly as the engine keys it. */
function child(
  journeyId: string,
  parentRunId: string,
  nodeId: string,
  { agent = true, tenantId = tenant }: { agent?: boolean; tenantId?: string } = {},
): NewRun {
  return {
    tenantId,
    journeyId,
    journeyVersion: 1,
    contactId: null,
    entityType: "contact",
    entityId: null,
    currentNodeId: randomUUID(),
    triggerEvent: "journey.started",
    triggerPayload: {
      origin: "journey", origin_run_id: parentRunId, origin_journey_id: randomUUID(), root_run_id: parentRunId, causation_depth: 1,
      ...(agent ? { requested_by: "ai_step" } : {}),
    },
    idempotencyKey: `journey.started:${parentRunId}:${nodeId}:${journeyId}`,
    resumeAt: new Date().toISOString(),
  };
}

const runCount = async () => Number((await db.query<{ n: number }>("select count(*)::int as n from public.journey_runs"))[0].n);

describe("journey_runs_one_child_per_ai_step_idx (migration 059)", () => {
  it("an AI step's second child, for a different journey, is refused: aiStepChildExists, and only the first run exists", async () => {
    const [b, c] = [await newJourney(), await newJourney()];
    const [parent, node] = [randomUUID(), randomUUID()];

    const first = await store.createRun(child(b, parent, node));
    assert.equal(first.created, true);
    assert.deepEqual(await store.createRun(child(c, parent, node)), { run: null, created: false, aiStepChildExists: true });
    assert.equal(await runCount(), 1);
    const [row] = await db.query<{ journey_id: string }>("select journey_id from public.journey_runs");
    assert.equal(row.journey_id, b);
  });

  it("every status counts: a finished child still holds its step", async () => {
    const [b, c] = [await newJourney(), await newJourney()];
    const [parent, node] = [randomUUID(), randomUUID()];
    await store.createRun(child(b, parent, node));
    for (const status of ["completed", "failed", "cancelled"]) {
      await db.query("update public.journey_runs set status = $1", [status]);
      assert.equal((await store.createRun(child(c, parent, node))).aiStepChildExists, true, status);
    }
    assert.equal(await runCount(), 1);
  });

  it("the same child again creates nothing (whichever unique rule the database reports)", async () => {
    const b = await newJourney();
    const [parent, node] = [randomUUID(), randomUUID()];
    const first = await store.createRun(child(b, parent, node));
    const again = await store.createRun(child(b, parent, node));
    assert.equal(again.created, false);
    if (again.run) assert.equal(again.run.id, first.run?.id);
    else assert.equal(again.aiStepChildExists, true);
    assert.equal(await runCount(), 1);
  });

  it("another AI step of the same run, another run's step, or another workspace each get their own child", async () => {
    const [b, c] = [await newJourney(), await newJourney()];
    const otherB = await newJourney(otherTenant);
    const [parent, node] = [randomUUID(), randomUUID()];
    await store.createRun(child(b, parent, node));

    assert.equal((await store.createRun(child(c, parent, randomUUID()))).created, true, "another node");
    assert.equal((await store.createRun(child(c, randomUUID(), node))).created, true, "another parent run");
    assert.equal((await store.createRun(child(otherB, parent, node, { tenantId: otherTenant }))).created, true, "another workspace");
    assert.equal(await runCount(), 4);
  });

  it("Start journey and Start journeys children aren't covered: one step may start several journeys", async () => {
    const [b, c] = [await newJourney(), await newJourney()];
    const [parent, node] = [randomUUID(), randomUUID()];
    assert.equal((await store.createRun(child(b, parent, node, { agent: false }))).created, true);
    assert.equal((await store.createRun(child(c, parent, node, { agent: false }))).created, true);
    assert.equal(await runCount(), 2);
  });

  it("the index exists with the name the store recognizes, is unique, and is partial on AI-requested children", async () => {
    const [index] = await db.query<{ definition: string }>(
      "select pg_get_indexdef(indexrelid) as definition from pg_index join pg_class on pg_class.oid = indexrelid where relname = $1",
      [AI_STEP_CHILD_INDEX],
    );
    assert.ok(index, "index exists");
    assert.match(index.definition, /CREATE UNIQUE INDEX/);
    assert.match(index.definition, /requested_by/);
    assert.match(index.definition, /journey\.started/);
  });
});
