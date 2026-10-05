/**
 * Archive, Restore, and safe Delete through the real repository functions,
 * on PGlite with the real journey schema (migrations 048, 054, 056) and
 * migration 058 applied. Reads and the journey writes run as a signed-in
 * member under RLS; run cancellation runs as the service role.
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
import { JOURNEY_ARCHIVED_ERROR } from "./engine.ts";
import { createTestDb, type TestDb } from "./lead-status-test-db.ts";

// The repository's user client (cookie-based in production) becomes the test member's PGlite client.
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

/** The real journey schema in place of the lead-status stand-in's bare journey_runs. */
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
-- Lets a test make the service-role run cancellation fail.
create table public.test_fail_run_cancel (on_ boolean);
create function public.test_fail_run_cancel() returns trigger language plpgsql as $$
begin
  if new.status = 'cancelled' and exists (select 1 from public.test_fail_run_cancel) then
    raise exception 'run cancellation failed (test)';
  end if;
  return new;
end $$;
create trigger test_fail_run_cancel before update on public.journey_runs
  for each row execute function public.test_fail_run_cancel();
`;

type Repository = typeof import("../journey-repository.ts");
type RunRepository = typeof import("../journey-run-repository.ts");

let db: TestDb;
let repo: Repository;
let runRepo: RunRepository;
let store: import("./engine.ts").JourneyRuntimeStore;

let tenant: string;
let otherTenant: string;
let member: string;
let otherMember: string;

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
  [tenant, otherTenant] = [await newTenant(), await newTenant()];
  [member, otherMember] = [randomUUID(), randomUUID()];
  for (const [user, tenantId] of [[member, tenant], [otherMember, otherTenant]]) {
    await db.query("insert into auth.users (id) values ($1)", [user]);
    await db.query("insert into public.test_memberships (user_id, tenant_id) values ($1, $2)", [user, tenantId]);
  }
  signIn(member);
});

function signIn(userId: string) {
  (globalThis as { __reosTestUserClient?: SupabaseClient }).__reosTestUserClient = db.client("authenticated", userId);
}

async function newTenant() {
  const [row] = await db.query<{ id: string }>("insert into public.tenants default values returning id");
  return row.id;
}

/** Manual trigger → Create task: a graph that passes activation. */
function graph() {
  const trigger = randomUUID();
  const task = randomUUID();
  return {
    nodes: [
      { id: trigger, type: "trigger" as const, name: "Manual", description: "", position: { x: 0, y: 0 }, config: { event: "manual", filters: [] } },
      { id: task, type: "action" as const, name: "Task", description: "", position: { x: 0, y: 120 }, config: { action: "create_task", title: "Call", notes: "", dueInDays: 1 } },
    ],
    connections: [{ id: randomUUID(), sourceNodeId: trigger, targetNodeId: task, sourceHandle: null, targetHandle: null }],
  };
}

/** A journey created through the repository (so it has its saved version snapshot), then put in `status`. */
async function newJourney(status = "active", tenantId = tenant, user = member) {
  signIn(user);
  const created = await repo.createJourney({ tenantId, userId: user, name: "Welcome", description: "", graph: graph() });
  assert.ok(created.ok, created.ok ? "" : created.error);
  await db.query("update public.journeys set status = $2 where id = $1", [created.value, status]);
  signIn(member);
  return created.value;
}

async function journeyRow(id: string) {
  const [row] = await db.query<{ status: string; version: number }>("select status, version from public.journeys where id = $1", [id]);
  return row;
}

async function insertRun(journeyId: string, status: string, tenantId = tenant) {
  const { version } = await journeyRow(journeyId);
  const [row] = await db.query<{ id: string }>(
    `insert into public.journey_runs
       (tenant_id, journey_id, journey_version, entity_type, status, trigger_event, idempotency_key, error, resume_at, locked_until, completed_at)
     values ($1, $2, $3, 'contact', $4, 'manual', $5, $6, $7, $8, $9)
     returning id`,
    [
      tenantId,
      journeyId,
      version,
      status,
      randomUUID(),
      status === "failed" ? "The lead has no mobile number." : status === "cancelled" ? "Cancelled by a team member." : null,
      status === "waiting" ? new Date(Date.now() + 86_400_000).toISOString() : null,
      status === "running" ? new Date(Date.now() + 60_000).toISOString() : null,
      ["completed", "failed", "cancelled"].includes(status) ? "2026-09-01T00:00:00Z" : null,
    ],
  );
  return row.id;
}

async function insertStep(runId: string, status: string, tenantId = tenant) {
  const [row] = await db.query<{ id: string }>(
    "insert into public.journey_run_steps (tenant_id, run_id, node_id, node_type, status) values ($1, $2, $3, 'action', $4) returning id",
    [tenantId, runId, randomUUID(), status],
  );
  return row.id;
}

async function run(id: string) {
  const [row] = await db.query<{
    status: string;
    error: string | null;
    completed_at: Date | null;
    resume_at: Date | null;
    locked_until: Date | null;
    journey_version: number;
  }>("select status, error, completed_at, resume_at, locked_until, journey_version from public.journey_runs where id = $1", [id]);
  return row;
}

async function stepStatus(id: string) {
  const [row] = await db.query<{ status: string }>("select status from public.journey_run_steps where id = $1", [id]);
  return row?.status;
}

async function count(table: string, column: string, value: string) {
  const [row] = await db.query<{ n: number }>(`select count(*)::int as n from public.${table} where ${column} = $1`, [value]);
  return row.n;
}

const setStatus = (journeyId: string, status: "draft" | "active" | "paused" | "archived", tenantId = tenant) =>
  repo.setJourneyStatus({ tenantId, userId: null, journeyId, status });

describe("archive", () => {
  it("archives an active journey and cancels only its running, waiting, and paused runs", async () => {
    const journey = await newJourney("active");
    const other = await newJourney("active");
    const runs = {
      running: await insertRun(journey, "running"),
      waiting: await insertRun(journey, "waiting"),
      paused: await insertRun(journey, "paused"),
      failed: await insertRun(journey, "failed"),
      completed: await insertRun(journey, "completed"),
      cancelled: await insertRun(journey, "cancelled"),
    };
    const otherJourneyRun = await insertRun(other, "waiting");
    const activeStep = await insertStep(runs.running, "running");
    const doneStep = await insertStep(runs.running, "completed");
    const historyStep = await insertStep(runs.completed, "completed");
    const finishedBefore = { failed: await run(runs.failed), completed: await run(runs.completed), cancelled: await run(runs.cancelled) };

    const result = await setStatus(journey, "archived");
    assert.ok(result.ok, result.ok ? "" : result.error);
    assert.equal(result.value.status, "archived");
    assert.equal((await journeyRow(journey)).status, "archived");

    for (const status of ["running", "waiting", "paused"] as const) {
      const after = await run(runs[status]);
      assert.equal(after.status, "cancelled", status);
      assert.equal(after.error, JOURNEY_ARCHIVED_ERROR, status);
      assert.ok(after.completed_at, status);
      assert.equal(after.resume_at, null, status);
      assert.equal(after.locked_until, null, status);
    }
    for (const status of ["failed", "completed", "cancelled"] as const) {
      assert.deepEqual(await run(runs[status]), finishedBefore[status], `${status} runs are unchanged`);
    }
    assert.equal(await stepStatus(activeStep), "skipped");
    assert.equal(await stepStatus(doneStep), "completed");
    assert.equal(await stepStatus(historyStep), "completed");
    assert.equal((await run(otherJourneyRun)).status, "waiting", "another journey's runs are untouched");
  });

  it("archives draft and paused journeys too", async () => {
    for (const status of ["draft", "paused"]) {
      const journey = await newJourney(status);
      const result = await setStatus(journey, "archived");
      assert.ok(result.ok, status);
      assert.equal((await journeyRow(journey)).status, "archived");
    }
  });

  it("archiving again repeats the cancellation for a run that survived it", async () => {
    const journey = await newJourney("archived");
    const survivor = await insertRun(journey, "waiting");
    const result = await setStatus(journey, "archived");
    assert.ok(result.ok);
    assert.equal((await run(survivor)).status, "cancelled");
    assert.equal((await run(survivor)).error, JOURNEY_ARCHIVED_ERROR);
  });

  it("when the cancellation fails, the journey isn't left archived and its runs stay active", async () => {
    const journey = await newJourney("active");
    const waiting = await insertRun(journey, "waiting");
    await db.query("insert into public.test_fail_run_cancel values (true)");

    const result = await setStatus(journey, "archived");
    assert.deepEqual(result, { ok: false, error: "Could not cancel the journey's active runs, so it wasn't archived. Try again." });
    assert.equal((await journeyRow(journey)).status, "active");
    assert.equal((await run(waiting)).status, "waiting");

    await db.query("delete from public.test_fail_run_cancel");
    assert.ok((await setStatus(journey, "archived")).ok);
    assert.equal((await run(waiting)).status, "cancelled");
  });

  it("history stays readable: runs, steps, versions, and each run's pinned snapshot", async () => {
    const journey = await newJourney("active");
    const completed = await insertRun(journey, "completed");
    const waiting = await insertRun(journey, "waiting");
    const steps = [await insertStep(completed, "completed"), await insertStep(waiting, "running")];
    const versionsBefore = await count("journey_versions", "journey_id", journey);
    assert.ok(versionsBefore > 0);

    assert.ok((await setStatus(journey, "archived")).ok);

    const userClient = db.client("authenticated", member);
    const { data: visibleRuns, error } = await userClient
      .from("journey_runs")
      .select("id, status, journey_version")
      .eq("tenant_id", tenant)
      .eq("journey_id", journey);
    assert.equal(error, null);
    assert.deepEqual(visibleRuns?.map((entry) => entry.id).sort(), [completed, waiting].sort());

    const listed = await runRepo.listJourneyRunSteps(tenant, [completed, waiting]);
    assert.ok(listed.ok);
    assert.deepEqual([...listed.value.values()].flat().map((step) => step.id).sort(), [...steps].sort());

    assert.equal(await count("journey_versions", "journey_id", journey), versionsBefore);
    for (const entry of visibleRuns ?? []) {
      assert.ok(await store.loadSnapshot(journey, entry.journey_version), "the run's pinned version still loads");
    }
  });
});

describe("execution exclusion on Postgres", () => {
  it("an archived journey is never a dispatch candidate; restored and re-activated, it is again", async () => {
    const journey = await newJourney("active");
    assert.deepEqual((await store.findCandidateJourneys(tenant, "manual")).map((entry) => entry.journeyId), [journey]);
    assert.ok((await setStatus(journey, "archived")).ok);
    assert.deepEqual(await store.findCandidateJourneys(tenant, "manual"), []);
    assert.equal(await store.journeyStatus(tenant, journey), "archived");
  });
});

describe("restore", () => {
  it("restores to draft without reopening cancelled runs, then activates through normal validation", async () => {
    const journey = await newJourney("active");
    const waiting = await insertRun(journey, "waiting");
    assert.ok((await setStatus(journey, "archived")).ok);

    const direct = await setStatus(journey, "active");
    assert.deepEqual(direct, { ok: false, error: "A archived journey cannot move to active." });

    const restored = await setStatus(journey, "draft");
    assert.ok(restored.ok);
    assert.equal(restored.value.status, "draft");
    assert.equal((await run(waiting)).status, "cancelled", "Restore doesn't reopen runs");

    const activated = await setStatus(journey, "active");
    assert.ok(activated.ok, activated.ok ? "" : activated.error);
    assert.equal((await run(waiting)).status, "cancelled", "activation doesn't reopen them either");
    const { version } = await journeyRow(journey);
    const [snapshot] = await db.query("select 1 from public.journey_versions where journey_id = $1 and version = $2", [journey, version]);
    assert.ok(snapshot, "the current version has its snapshot");
    assert.deepEqual((await store.findCandidateJourneys(tenant, "manual")).map((entry) => entry.journeyId), [journey]);
  });

  it("activation of a restored draft still runs the activation checks", async () => {
    const journey = await newJourney("archived");
    await db.query("delete from public.journey_connections where journey_id = $1", [journey]);
    assert.ok((await setStatus(journey, "draft")).ok);
    const activated = await setStatus(journey, "active");
    assert.equal(activated.ok, false);
    assert.equal((await journeyRow(journey)).status, "draft");
  });
});

describe("editing", () => {
  it("saving an archived journey is rejected and changes nothing", async () => {
    const journey = await newJourney("archived");
    const before = await journeyRow(journey);
    const result = await repo.saveJourney({
      tenantId: tenant,
      userId: member,
      journeyId: journey,
      name: "Renamed",
      description: "",
      graph: graph(),
      expectedVersion: before.version,
    });
    assert.deepEqual(result, { ok: false, error: "Restore this journey to edit it." });
    assert.deepEqual(await journeyRow(journey), before);
  });
});

describe("safe deletion", () => {
  const HISTORY_ERROR = "This journey has run history, so it can't be deleted. Archive it instead.";

  it("a journey that never ran deletes, with its versions and canvas", async () => {
    for (const status of ["draft", "archived", "active"]) {
      const journey = await newJourney(status);
      assert.ok((await count("journey_versions", "journey_id", journey)) > 0);
      assert.deepEqual(await repo.deleteJourney(tenant, journey), { ok: true, value: null }, status);
      assert.equal(await count("journeys", "id", journey), 0);
      assert.equal(await count("journey_versions", "journey_id", journey), 0);
      assert.equal(await count("journey_nodes", "journey_id", journey), 0);
    }
  });

  for (const status of ["completed", "failed", "cancelled", "waiting"]) {
    it(`a journey with a ${status} run can't be deleted, and everything stays`, async () => {
      const journey = await newJourney("archived");
      const runId = await insertRun(journey, status);
      const step = await insertStep(runId, "completed");
      const versions = await count("journey_versions", "journey_id", journey);

      assert.deepEqual(await repo.deleteJourney(tenant, journey), { ok: false, error: HISTORY_ERROR });
      assert.equal(await count("journeys", "id", journey), 1);
      assert.equal((await run(runId)).status, status);
      assert.equal(await stepStatus(step), "completed");
      assert.equal(await count("journey_versions", "journey_id", journey), versions);
    });
  }

  it("the database itself rejects the delete (error 23503), not only the app", async () => {
    const journey = await newJourney("active");
    await insertRun(journey, "completed");
    const { error } = await db.client("authenticated", member).from("journeys").delete().eq("id", journey);
    assert.equal(error?.code, "23503");
    await assert.rejects(db.query("delete from public.journeys where id = $1", [journey]), { code: "23503" });
  });

  it("both run foreign keys are NO ACTION; the other journey foreign keys still cascade", async () => {
    const rows = await db.query<{ conname: string; confdeltype: string }>(
      `select conname, confdeltype from pg_constraint
        where contype = 'f' and conrelid in ('public.journey_runs'::regclass, 'public.journey_versions'::regclass, 'public.journey_run_steps'::regclass)
        order by conname`,
    );
    const action = Object.fromEntries(rows.map((row) => [row.conname, row.confdeltype]));
    assert.equal(action.journey_runs_journey_id_fkey, "a");
    assert.equal(action.journey_runs_journey_id_journey_version_fkey, "a");
    assert.equal(action.journey_versions_journey_id_fkey, "c");
    assert.equal(action.journey_run_steps_run_id_fkey, "c");
    assert.equal(action.journey_runs_tenant_id_fkey, "c");
  });

  it("deleting a tenant still removes its journeys, versions, runs, and steps in one statement", async () => {
    const journey = await newJourney("active");
    const runId = await insertRun(journey, "completed");
    await insertStep(runId, "completed");
    const otherJourney = await newJourney("active", otherTenant, otherMember);
    const otherRun = await insertRun(otherJourney, "completed", otherTenant);

    await db.query("delete from public.tenants where id = $1", [tenant]);
    assert.equal(await count("journeys", "tenant_id", tenant), 0);
    assert.equal(await count("journey_versions", "tenant_id", tenant), 0);
    assert.equal(await count("journey_runs", "tenant_id", tenant), 0);
    assert.equal(await count("journey_run_steps", "tenant_id", tenant), 0);
    assert.equal((await run(otherRun)).status, "completed", "another tenant is untouched");
  });
});

describe("tenant isolation", () => {
  it("another workspace's journey is not found for archive, restore, and delete, and its runs don't change", async () => {
    const theirs = await newJourney("active", otherTenant, otherMember);
    const theirRun = await insertRun(theirs, "waiting", otherTenant);
    const archivedTheirs = await newJourney("archived", otherTenant, otherMember);
    signIn(member);

    assert.deepEqual(await setStatus(theirs, "archived"), { ok: false, error: "Journey not found." });
    assert.deepEqual(await setStatus(archivedTheirs, "draft"), { ok: false, error: "Journey not found." });
    assert.deepEqual(await repo.deleteJourney(tenant, archivedTheirs), { ok: false, error: "Journey not found." });

    // Even naming their tenant doesn't help: RLS hides their journeys from this member.
    assert.deepEqual(await setStatus(theirs, "archived", otherTenant), { ok: false, error: "Journey not found." });
    assert.deepEqual(await repo.deleteJourney(otherTenant, archivedTheirs), { ok: false, error: "Journey not found." });

    assert.equal((await journeyRow(theirs)).status, "active");
    assert.equal((await journeyRow(archivedTheirs)).status, "archived");
    assert.equal((await run(theirRun)).status, "waiting");
  });

  it("cancelling active runs is scoped to the tenant", async () => {
    const theirs = await newJourney("active", otherTenant, otherMember);
    const theirRun = await insertRun(theirs, "waiting", otherTenant);
    const result = await runRepo.cancelActiveJourneyRuns(tenant, theirs);
    assert.deepEqual(result, { ok: true, value: { cancelled: 0 } });
    assert.equal((await run(theirRun)).status, "waiting");
  });
});
