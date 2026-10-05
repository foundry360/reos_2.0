/**
 * The Supabase store's manual-retry write against PGlite with the real
 * active-run index (migration 056): one atomic update filtered by tenant, run,
 * failed status, and node, and the index as the final guard.
 *
 * Fail-closed: the test env replaces fetch and sockets before any production
 * module loads, so nothing can reach a real Supabase project.
 */

import { blockedRequests, attachTestDb } from "./live-actions-test-env.ts";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, beforeEach, describe, it } from "node:test";
import type { JourneyRuntimeStore, RunState } from "./engine.ts";
import { createTestDb, type TestDb } from "./lead-status-test-db.ts";
import { retryContext } from "./run-retry.ts";

/** The journey_runs columns the retry write touches, beyond the lead-status stand-in. */
const RUN_COLUMNS_SCHEMA = `
alter table public.journey_runs
  add column current_node_id text,
  add column context jsonb not null default '{}'::jsonb,
  add column error text,
  add column resume_at timestamptz,
  add column completed_at timestamptz,
  add column locked_until timestamptz;
`;

const NOW = "2026-10-01T12:00:00.000Z";

let db: TestDb;
let store: JourneyRuntimeStore;
let tenant: string;
let contact: string;
let journey: string;

before(async () => {
  db = await createTestDb({ schema: RUN_COLUMNS_SCHEMA });
  attachTestDb(db);
  const { createSupabaseJourneyStore } = await import("./supabase-store.ts");
  store = createSupabaseJourneyStore(db.client("service_role"));
});

after(async () => {
  await db.pg.close();
  assert.deepEqual(blockedRequests, []);
});

beforeEach(async () => {
  await db.reset();
  tenant = await newTenant();
  contact = await newContact(tenant);
  journey = randomUUID();
});

async function newTenant() {
  const [row] = await db.query<{ id: string }>("insert into public.tenants default values returning id");
  return row.id;
}

async function newContact(tenantId: string) {
  const [row] = await db.query<{ id: string }>("insert into public.contacts (tenant_id) values ($1) returning id", [tenantId]);
  return row.id;
}

const failedContext: RunState = { steps: { assign: { output: { ok: true } } }, attempts: { s: 1 } };

async function insertRun(run: { status?: string; tenantId?: string; nodeId?: string; key?: string } = {}) {
  const [row] = await db.query<{ id: string }>(
    `insert into public.journey_runs
       (tenant_id, journey_id, contact_id, status, idempotency_key, current_node_id, context, error, completed_at, resume_at, locked_until)
     values ($1, $2, $3, $4, $5, $6, $7, 'The lead has no mobile number.', now(), null, null)
     returning id`,
    [run.tenantId ?? tenant, journey, contact, run.status ?? "failed", run.key ?? randomUUID(), run.nodeId ?? "s", JSON.stringify(failedContext)],
  );
  return row.id;
}

async function row(id: string) {
  const [found] = await db.query<{
    status: string;
    current_node_id: string;
    context: RunState;
    error: string | null;
    resume_at: Date | null;
    completed_at: Date | null;
    locked_until: Date | null;
  }>("select status, current_node_id, context, error, resume_at, completed_at, locked_until from public.journey_runs where id = $1", [id]);
  return found;
}

const write = (id: string, tenantId = tenant, nodeId = "s") =>
  store.retryFailedRun(tenantId, id, nodeId, retryContext(failedContext, nodeId), NOW);

describe("retryFailedRun on Postgres", () => {
  it("moves the failed run to waiting, due at resumeAt, with the retry context", async () => {
    const id = await insertRun();
    assert.equal(await write(id), "retried");
    const after = await row(id);
    assert.equal(after.status, "waiting");
    assert.equal(after.resume_at?.toISOString(), NOW);
    assert.equal(after.error, null);
    assert.equal(after.completed_at, null);
    assert.equal(after.locked_until, null);
    assert.equal(after.current_node_id, "s");
    assert.deepEqual(after.context, { steps: { assign: { output: { ok: true } } }, attempts: { s: 2 } });
  });

  it("another workspace's tenant id updates nothing", async () => {
    const id = await insertRun();
    assert.equal(await write(id, await newTenant()), "not_failed");
    assert.equal((await row(id)).status, "failed");
  });

  it("a run that isn't failed, or failed at another node, isn't touched", async () => {
    for (const status of ["completed", "cancelled"]) {
      const id = await insertRun({ status });
      assert.equal(await write(id), "not_failed", status);
      assert.equal((await row(id)).status, status);
    }
    const id = await insertRun();
    assert.equal(await write(id, tenant, "other-node"), "not_failed");
    assert.equal((await row(id)).status, "failed");
  });

  it("the second of two retries gets not_failed", async () => {
    const id = await insertRun();
    const results = await Promise.all([write(id), write(id)]);
    assert.deepEqual(results.sort(), ["not_failed", "retried"]);
    assert.equal((await row(id)).status, "waiting");
  });

  it("the active-run index rejects the retry while the contact has an active run, and the run stays failed", async () => {
    const id = await insertRun();
    for (const status of ["running", "waiting", "paused"]) {
      const active = await insertRun({ status });
      assert.equal(await write(id), "active_run", status);
      const after = await row(id);
      assert.equal(after.status, "failed");
      assert.equal(after.error, "The lead has no mobile number.");
      await db.query("update public.journey_runs set status = 'completed' where id = $1", [active]);
    }
    assert.equal(await write(id), "retried", "once the other run finishes, the retry goes through");
  });

  it("other failed runs of the same contact don't block it", async () => {
    await insertRun();
    const id = await insertRun();
    assert.equal(await write(id), "retried");
  });
});
