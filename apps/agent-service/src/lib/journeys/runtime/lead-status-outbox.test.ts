/**
 * Outbox delivery: real claim/complete/fail functions (migration 055 on PGlite,
 * called through supabase-js), real dispatchJourneyEvent, in-memory journey store.
 */

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, beforeEach, describe, it } from "node:test";
import { withStatusOrigin } from "../../crm/status-origin.ts";
import type { JourneyAIExecutor } from "./ai.ts";
import type { ConditionRule } from "./contracts.ts";
import { dispatchJourneyEvent, idempotencyKey, type ActionExecutor, type EngineDeps, type JourneyEvent } from "./engine.ts";
import type { JourneySnapshot } from "./graph.ts";
import {
  createSupabaseLeadStatusOutbox,
  DEFAULT_OUTBOX_OPTIONS,
  dispatchLeadStatusEvents,
  leadStatusJourneyEvent,
  MAX_LEAD_STATUS_EVENT_ATTEMPTS,
  type LeadStatusEventRow,
  type LeadStatusOutbox,
} from "./lead-status-outbox.ts";
import { createTestDb, type TestDb } from "./lead-status-test-db.ts";
import { MemoryJourneyStore } from "./memory-store.ts";

interface OutboxRow {
  id: string;
  dispatched_at: Date | null;
  attempt_count: number;
  last_error: string | null;
  failed_at: Date | null;
  next_attempt_at: Date;
  locked_until: Date | null;
  claim_token: string | null;
}

let db: TestDb;
let tenant: string;
let store: MemoryJourneyStore;
let deps: EngineDeps;
let outbox: LeadStatusOutbox;

const ai: JourneyAIExecutor = { execute: async () => ({ success: true, output: {}, text: "" }) };
const actions: ActionExecutor = { execute: async () => ({ status: "completed", output: {} }) };

before(async () => {
  db = await createTestDb();
});

after(async () => {
  await db.pg.close();
});

beforeEach(async () => {
  await db.reset();
  tenant = await newTenant();
  store = new MemoryJourneyStore();
  deps = { store, actions, ai };
  outbox = createSupabaseLeadStatusOutbox(db.client("service_role"));
});

async function newTenant(): Promise<string> {
  const [row] = await db.query<{ id: string }>("insert into public.tenants default values returning id");
  return row.id;
}

/** A lead in Postgres (where the trigger runs) mirrored into the journey store (where dispatch reads it). */
async function newLead(tenantId = tenant, status = "New"): Promise<string> {
  const [row] = await db.query<{ id: string }>(
    "insert into public.contacts (tenant_id, lead_status) values ($1, $2) returning id",
    [tenantId, status],
  );
  store.contacts.set(row.id, { tenantId, lead: { lead_status: status, record_type: "lead" } });
  return row.id;
}

async function setStatus(contactId: string, status: string) {
  await db.query("update public.contacts set lead_status = $2 where id = $1", [contactId, status]);
  store.contacts.get(contactId)!.lead.lead_status = status;
}

/** Trigger → one task; the run completes in the same pass, so no active run guards a second delivery. */
function statusJourney(journeyId: string, filters: ConditionRule[] = [], tenantId = tenant, event = "lead.status_changed") {
  const snapshot: JourneySnapshot = {
    nodes: [
      { id: `${journeyId}-t`, type: "trigger", name: "Trigger", description: "", config: { event, filters } },
      { id: `${journeyId}-a`, type: "action", name: "Task", description: "", config: { action: "create_task", title: "Follow up", notes: "", dueInDays: 1 } },
    ],
    connections: [{ id: `${journeyId}-c`, sourceNodeId: `${journeyId}-t`, targetNodeId: `${journeyId}-a`, sourceHandle: null, targetHandle: null }],
  };
  store.saveJourney(tenantId, journeyId, snapshot);
}

const to = (value: string): ConditionRule => ({ field: "trigger.to_status", operator: "equals", value });
const from = (value: string): ConditionRule => ({ field: "trigger.from_status", operator: "equals", value });

async function drain(dispatch: (event: JourneyEvent) => Promise<unknown> = (event) => dispatchJourneyEvent(deps, event)) {
  return dispatchLeadStatusEvents(outbox, dispatch, { ...DEFAULT_OUTBOX_OPTIONS, budgetMs: 60_000 });
}

async function rows(): Promise<OutboxRow[]> {
  return db.query<OutboxRow>("select * from public.lead_status_events order by created_at, id");
}

const runs = () => [...store.runs.values()];

describe("lead status outbox dispatch", () => {
  it("uses the outbox row id as sourceId and puts the transition in the payload", async () => {
    statusJourney("j-any");
    const lead = await newLead();
    await setStatus(lead, "Working");
    const [row] = await rows();

    const delivered: JourneyEvent[] = [];
    await drain(async (event) => {
      delivered.push(event);
      return dispatchJourneyEvent(deps, event);
    });

    assert.equal(delivered.length, 1);
    assert.equal(delivered[0].type, "lead.status_changed");
    assert.equal(delivered[0].sourceId, row.id);
    assert.equal(delivered[0].tenantId, tenant);
    assert.equal(delivered[0].contactId, lead);
    assert.deepEqual(
      { ...delivered[0].payload, changed_at: undefined },
      { event_id: row.id, from_status: "New", to_status: "Working", origin: "system", actor_user_id: null, origin_run_id: null, converted: false, changed_at: undefined, causation_depth: 0 },
    );
    const [run] = runs();
    assert.equal(run.idempotencyKey, `lead.status_changed:${row.id}:j-any`);
  });

  it("marks a delivered row dispatched and releases its claim", async () => {
    statusJourney("j-any");
    const lead = await newLead();
    await setStatus(lead, "Working");

    const summary = await drain();
    assert.deepEqual(summary, { claimed: 1, delivered: 1, depthLimited: 0, failed: 0, permanentlyFailed: 0 });
    const [row] = await rows();
    assert.ok(row.dispatched_at);
    assert.equal(row.claim_token, null);
    assert.equal(row.locked_until, null);
    assert.equal((await drain()).claimed, 0);
  });

  it("delivering the same row again never creates a second run", async () => {
    statusJourney("j-any");
    const lead = await newLead();
    await setStatus(lead, "Working");
    await drain();
    assert.equal(runs().length, 1);
    assert.equal(runs()[0].status, "completed");

    // Redelivery (e.g. the dispatcher died before marking the row): the run already completed,
    // so only the idempotency key stands between this delivery and a duplicate run.
    await db.query("update public.lead_status_events set dispatched_at = null");
    const outcomes: unknown[] = [];
    await drain(async (event) => {
      const result = await dispatchJourneyEvent(deps, event);
      outcomes.push(...result.map((entry) => entry.result));
      return result;
    });
    assert.deepEqual(outcomes, ["duplicate"]);
    assert.equal(runs().length, 1);
  });

  it("the idempotency key is deterministic per outbox row", async () => {
    const lead = await newLead();
    await setStatus(lead, "Working");
    const [claimed] = await outbox.claim({ limit: 1, leaseSeconds: 60 });
    const first = leadStatusJourneyEvent(claimed);
    const second = leadStatusJourneyEvent({ ...claimed, claim_token: "another-claim" });
    assert.equal(idempotencyKey(first, "j", 3), idempotencyKey(second, "j", 3));
  });

  it("a claimed row is invisible to a second dispatcher until its claim expires", async () => {
    const lead = await newLead();
    await setStatus(lead, "Working");
    const first = await outbox.claim({ limit: 10, leaseSeconds: 120 });
    assert.equal(first.length, 1);
    assert.equal((await outbox.claim({ limit: 10, leaseSeconds: 120 })).length, 0);

    await db.query("update public.lead_status_events set locked_until = now() - interval '1 second'");
    const reclaimed = await outbox.claim({ limit: 10, leaseSeconds: 120 });
    assert.equal(reclaimed.length, 1);
    assert.notEqual(reclaimed[0].claim_token, first[0].claim_token);
  });

  it("a stale claim can't complete or fail a row someone else re-claimed", async () => {
    const lead = await newLead();
    await setStatus(lead, "Working");
    const [stale] = await outbox.claim({ limit: 1, leaseSeconds: 120 });
    await db.query("update public.lead_status_events set locked_until = now() - interval '1 second'");
    const [current] = await outbox.claim({ limit: 1, leaseSeconds: 120 });

    assert.equal(await outbox.fail(stale, "late failure"), "stale");
    await outbox.complete(stale);
    let [row] = await rows();
    assert.equal(row.dispatched_at, null);
    assert.equal(row.attempt_count, 2, "one per claim; the stale failure changes nothing");
    assert.equal(row.last_error, null);
    assert.equal(row.claim_token, current.claim_token);

    await outbox.complete(current);
    [row] = await rows();
    assert.ok(row.dispatched_at);
  });

  it("a failed delivery stays pending with the error, attempt count, and a backoff", async () => {
    statusJourney("j-any");
    const lead = await newLead();
    await setStatus(lead, "Working");

    const summary = await drain(async () => {
      throw new Error("database unavailable");
    });
    assert.deepEqual(summary, { claimed: 1, delivered: 0, depthLimited: 0, failed: 1, permanentlyFailed: 0 });
    let [row] = await rows();
    assert.equal(row.dispatched_at, null);
    assert.equal(row.attempt_count, 1);
    assert.equal(row.last_error, "database unavailable");
    assert.equal(row.claim_token, null);
    assert.ok(row.next_attempt_at.getTime() > Date.now());
    assert.equal((await drain()).claimed, 0, "not retried before the backoff");

    await db.query("update public.lead_status_events set next_attempt_at = now()");
    assert.deepEqual(await drain(), { claimed: 1, delivered: 1, depthLimited: 0, failed: 0, permanentlyFailed: 0 });
    [row] = await rows();
    assert.ok(row.dispatched_at);
    assert.equal(row.last_error, null);
    assert.equal(row.attempt_count, 2);
    assert.equal(row.failed_at, null);
    assert.equal(runs().length, 1);
  });

  it("one failing row doesn't hold up the others", async () => {
    const a = await newLead();
    const b = await newLead();
    await setStatus(a, "Working");
    await setStatus(b, "Working");

    const summary = await drain(async (event) => {
      if (event.contactId === a) throw new Error("boom");
    });
    assert.deepEqual(summary, { claimed: 2, delivered: 1, depthLimited: 0, failed: 1, permanentlyFailed: 0 });
  });

  it("delivers a contact's transitions in the order they happened", async () => {
    statusJourney("j-any");
    const lead = await newLead();
    await setStatus(lead, "Working");
    await setStatus(lead, "Contacted");
    await setStatus(lead, "Qualified");

    const seen: string[] = [];
    await drain(async (event) => {
      seen.push(`${event.payload.from_status}→${event.payload.to_status}`);
    });
    assert.deepEqual(seen, ["New→Working", "Working→Contacted", "Contacted→Qualified"]);
  });
});

describe("lead status outbox bounded retries (migration 057)", () => {
  const claimOne = () => outbox.claim({ limit: 10, leaseSeconds: 120 });
  const retryNow = () => db.query("update public.lead_status_events set next_attempt_at = now() where failed_at is null");
  const expireClaims = () => db.query("update public.lead_status_events set locked_until = now() - interval '1 second'");
  const setAttempts = (id: string, count: number) =>
    db.query("update public.lead_status_events set attempt_count = $2 where id = $1", [id, count]);
  const failing = async () => {
    throw new Error("database unavailable");
  };

  async function pendingEvent(): Promise<string> {
    const lead = await newLead();
    await setStatus(lead, "Working");
    return (await rows()).at(-1)!.id;
  }

  async function row(id: string): Promise<OutboxRow> {
    const [found] = await db.query<OutboxRow>("select * from public.lead_status_events where id = $1", [id]);
    return found;
  }

  it("a successful claim counts the attempt", async () => {
    const id = await pendingEvent();
    assert.equal((await row(id)).attempt_count, 0);
    const [claimed] = await claimOne();
    assert.equal(claimed.attempt_count, 1);
    assert.equal((await row(id)).attempt_count, 1);
  });

  it("a reported failure doesn't count the attempt again", async () => {
    const id = await pendingEvent();
    const [claimed] = await claimOne();
    assert.equal(await outbox.fail(claimed, "boom"), "retry");
    const failed = await row(id);
    assert.equal(failed.attempt_count, 1);
    assert.equal(failed.failed_at, null);
    assert.equal(failed.claim_token, null);
    assert.equal(failed.locked_until, null);
  });

  it("retries after 1, 2, 4, 8, 16, 32, 60, 60, 60 minutes, then fails permanently", async () => {
    const id = await pendingEvent();
    const delays: number[] = [];
    for (let attempt = 1; attempt < MAX_LEAD_STATUS_EVENT_ATTEMPTS; attempt++) {
      const [claimed] = await claimOne();
      assert.equal(claimed.attempt_count, attempt);
      assert.equal(await outbox.fail(claimed, `failure ${attempt}`), "retry");
      const [{ minutes }] = await db.query<{ minutes: number }>(
        "select round(extract(epoch from next_attempt_at - now()) / 60)::int as minutes from public.lead_status_events where id = $1",
        [id],
      );
      delays.push(minutes);
      await retryNow();
    }
    assert.deepEqual(delays, [1, 2, 4, 8, 16, 32, 60, 60, 60]);

    const [last] = await claimOne();
    assert.equal(last.attempt_count, MAX_LEAD_STATUS_EVENT_ATTEMPTS);
    assert.equal(await outbox.fail(last, "failure 10"), "failed");
    assert.ok((await row(id)).failed_at);
  });

  it("the 10th attempt runs; its failure sets failed_at, keeps last_error, and schedules nothing", async () => {
    const id = await pendingEvent();
    await setAttempts(id, MAX_LEAD_STATUS_EVENT_ATTEMPTS - 1);
    const before = await row(id);

    let attempted = 0;
    const logs: string[] = [];
    const summary = await dispatchLeadStatusEvents(
      outbox,
      async () => {
        attempted++;
        throw new Error("database unavailable");
      },
      { ...DEFAULT_OUTBOX_OPTIONS, budgetMs: 60_000 },
      Date.now,
      (message) => logs.push(message),
    );

    assert.equal(attempted, 1);
    assert.deepEqual(summary, { claimed: 1, delivered: 0, depthLimited: 0, failed: 1, permanentlyFailed: 1 });
    assert.deepEqual(logs, [`[journeys] lead status event ${id} permanently failed after 10 attempts: database unavailable`]);

    const failed = await row(id);
    assert.ok(failed.failed_at);
    assert.equal(failed.dispatched_at, null);
    assert.equal(failed.attempt_count, MAX_LEAD_STATUS_EVENT_ATTEMPTS);
    assert.equal(failed.last_error, "database unavailable");
    assert.equal(failed.next_attempt_at.getTime(), before.next_attempt_at.getTime(), "no retry scheduled");
    assert.equal(failed.claim_token, null);
    assert.equal(failed.locked_until, null);

    await db.query("update public.lead_status_events set next_attempt_at = now() - interval '1 day'");
    assert.equal((await claimOne()).length, 0);
  });

  it("a row that has used all its attempts is never claimed", async () => {
    const id = await pendingEvent();
    await setAttempts(id, MAX_LEAD_STATUS_EVENT_ATTEMPTS);
    assert.equal((await claimOne()).length, 0);
    assert.equal((await row(id)).attempt_count, MAX_LEAD_STATUS_EVENT_ATTEMPTS);
  });

  it("a dispatcher that keeps dying mid-delivery still exhausts the attempts without fail being called", async () => {
    const id = await pendingEvent();
    for (let attempt = 1; attempt <= MAX_LEAD_STATUS_EVENT_ATTEMPTS; attempt++) {
      const claimed = await claimOne();
      assert.equal(claimed.length, 1, `claim ${attempt}`);
      assert.equal(claimed[0].attempt_count, attempt);
      await expireClaims();
    }
    assert.equal((await claimOne()).length, 0);
    const exhausted = await row(id);
    assert.equal(exhausted.attempt_count, MAX_LEAD_STATUS_EVENT_ATTEMPTS);
    assert.equal(exhausted.dispatched_at, null);
  });

  it("a delivery that succeeds before the limit is dispatched, not failed", async () => {
    statusJourney("j-any");
    const id = await pendingEvent();
    assert.deepEqual(await drain(failing), { claimed: 1, delivered: 0, depthLimited: 0, failed: 1, permanentlyFailed: 0 });
    await setAttempts(id, MAX_LEAD_STATUS_EVENT_ATTEMPTS - 1);
    await retryNow();

    assert.deepEqual(await drain(), { claimed: 1, delivered: 1, depthLimited: 0, failed: 0, permanentlyFailed: 0 });
    const delivered = await row(id);
    assert.ok(delivered.dispatched_at);
    assert.equal(delivered.failed_at, null);
    assert.equal(delivered.last_error, null);
    assert.equal(delivered.attempt_count, MAX_LEAD_STATUS_EVENT_ATTEMPTS);
    assert.equal(runs().length, 1);
  });

  it("a stale claim can't permanently fail a row another dispatcher holds", async () => {
    const id = await pendingEvent();
    await setAttempts(id, MAX_LEAD_STATUS_EVENT_ATTEMPTS - 2);
    const [stale] = await claimOne();
    await expireClaims();
    const [current] = await claimOne();
    assert.equal(current.attempt_count, MAX_LEAD_STATUS_EVENT_ATTEMPTS);

    assert.equal(await outbox.fail(stale, "late failure"), "stale");
    let held = await row(id);
    assert.equal(held.failed_at, null);
    assert.equal(held.last_error, null);
    assert.equal(held.claim_token, current.claim_token);

    assert.equal(await outbox.fail(current, "real failure"), "failed");
    held = await row(id);
    assert.ok(held.failed_at);
    assert.equal(held.last_error, "real failure");
  });

  it("a permanently failed row doesn't hold up other rows", async () => {
    const doomed = await pendingEvent();
    const healthy = await pendingEvent();
    await setAttempts(doomed, MAX_LEAD_STATUS_EVENT_ATTEMPTS - 1);

    const summary = await dispatchLeadStatusEvents(
      outbox,
      async (event) => {
        if (event.sourceId === doomed) throw new Error("boom");
      },
      { ...DEFAULT_OUTBOX_OPTIONS, budgetMs: 60_000 },
      Date.now,
      () => undefined,
    );
    assert.deepEqual(summary, { claimed: 2, delivered: 1, depthLimited: 0, failed: 1, permanentlyFailed: 1 });
    assert.ok((await row(doomed)).failed_at);
    assert.ok((await row(healthy)).dispatched_at);

    const later = await pendingEvent();
    const claimed = await claimOne();
    assert.deepEqual(claimed.map((entry) => entry.id), [later]);
  });

  it("the documented requeue gives a permanently failed event a fresh set of attempts", async () => {
    const id = await pendingEvent();
    await setAttempts(id, MAX_LEAD_STATUS_EVENT_ATTEMPTS - 1);
    const [last] = await claimOne();
    assert.equal(await outbox.fail(last, "boom"), "failed");

    await db.query(
      `update public.lead_status_events
          set failed_at = null, attempt_count = 0, next_attempt_at = now(),
              locked_until = null, claim_token = null
        where id = $1 and dispatched_at is null`,
      [id],
    );
    const [requeued] = await claimOne();
    assert.equal(requeued.id, id);
    assert.equal(requeued.attempt_count, 1);
    assert.equal(requeued.to_status, "Working");
  });

  it("migration 057: failed_at column, pending index predicate, single function signatures", async () => {
    const [column] = await db.query<{ data_type: string; is_nullable: string; column_default: string | null }>(
      "select data_type, is_nullable, column_default from information_schema.columns where table_name = 'lead_status_events' and column_name = 'failed_at'",
    );
    assert.deepEqual(column, { data_type: "timestamp with time zone", is_nullable: "YES", column_default: null });

    const [index] = await db.query<{ indexdef: string }>(
      "select indexdef from pg_indexes where indexname = 'lead_status_events_pending_idx'",
    );
    assert.match(index.indexdef, /\(next_attempt_at, created_at\) WHERE \(\(dispatched_at IS NULL\) AND \(failed_at IS NULL\)\)$/);

    const signatures = await db.query<{ signature: string }>(
      `select p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')' as signature
         from pg_proc p where p.proname in ('claim_lead_status_events', 'fail_lead_status_event') order by 1`,
    );
    assert.deepEqual(signatures.map((entry) => entry.signature), [
      "claim_lead_status_events(p_limit integer, p_lease_seconds integer, p_tenant_id uuid, p_contact_id uuid, p_max_attempts integer)",
      "fail_lead_status_event(p_id uuid, p_claim_token uuid, p_error text, p_max_attempts integer)",
    ]);
  });
});

describe("trigger filters", () => {
  beforeEach(() => {
    statusJourney("to-qualified", [to("Qualified")]);
    statusJourney("from-working", [from("Working")]);
    statusJourney("working-to-qualified", [from("Working"), to("Qualified")]);
    statusJourney("any-change", []);
  });

  const started = () => runs().map((run) => run.journeyId).sort();

  it("Working → Qualified matches to-only, from-only, from+to, and any", async () => {
    const lead = await newLead(tenant, "Working");
    await setStatus(lead, "Qualified");
    await drain();
    assert.deepEqual(started(), ["any-change", "from-working", "to-qualified", "working-to-qualified"]);
  });

  it("New → Qualified matches to-only and any, not the from filters", async () => {
    const lead = await newLead(tenant, "New");
    await setStatus(lead, "Qualified");
    await drain();
    assert.deepEqual(started(), ["any-change", "to-qualified"]);
  });

  it("Working → Contacted matches from-only and any", async () => {
    const lead = await newLead(tenant, "Working");
    await setStatus(lead, "Contacted");
    await drain();
    assert.deepEqual(started(), ["any-change", "from-working"]);
  });

  it("same → same starts nothing because no event exists", async () => {
    const lead = await newLead(tenant, "Qualified");
    await setStatus(lead, "Qualified");
    assert.equal((await drain()).claimed, 0);
    assert.deepEqual(started(), []);
  });
});

describe("conversion", () => {
  it("one conversion, written by several paths, starts a to=Converted journey once with converted = true", async () => {
    statusJourney("on-converted", [to("Converted")]);
    const lead = await newLead(tenant, "Qualified");
    await db.query(
      "update public.contacts set lead_status = 'Converted', record_type = 'contact', contact_type = 'Prospect' where id = $1",
      [lead],
    );
    await db.query(
      "update public.contacts set lead_status = 'Converted', record_type = 'contact' where id = $1 and record_type <> 'contact'",
      [lead],
    );
    await db.query("update public.contacts set lead_status = 'Converted', appt_booked = true where id = $1", [lead]);
    store.contacts.get(lead)!.lead = { lead_status: "Converted", record_type: "contact" };

    const delivered: JourneyEvent[] = [];
    await drain(async (event) => {
      delivered.push(event);
      return dispatchJourneyEvent(deps, event);
    });
    assert.equal(delivered.length, 1);
    assert.equal(delivered[0].payload.to_status, "Converted");
    assert.equal(delivered[0].payload.converted, true);
    assert.deepEqual(runs().map((run) => run.journeyId), ["on-converted"]);
  });
});

describe("tenant isolation", () => {
  it("an event only reaches journeys in its own workspace", async () => {
    const otherTenant = await newTenant();
    statusJourney("tenant-a-journey", [], tenant);
    statusJourney("tenant-b-journey", [], otherTenant);
    const lead = await newLead(otherTenant);
    await setStatus(lead, "Working");
    await drain();
    assert.deepEqual(runs().map((run) => [run.journeyId, run.tenantId]), [["tenant-b-journey", otherTenant]]);
  });

  it("a contact-scoped claim (the CRM's immediate delivery) only takes that contact's rows", async () => {
    const otherTenant = await newTenant();
    const mine = await newLead(tenant);
    const theirs = await newLead(otherTenant);
    await setStatus(mine, "Working");
    await setStatus(theirs, "Working");

    const claimed = await outbox.claim({ limit: 10, leaseSeconds: 60, tenantId: tenant, contactId: mine });
    assert.deepEqual(claimed.map((row: LeadStatusEventRow) => row.contact_id), [mine]);
    const crossTenant = await outbox.claim({ limit: 10, leaseSeconds: 60, tenantId: tenant, contactId: theirs });
    assert.equal(crossTenant.length, 0);
  });
});

describe("other journey events", () => {
  it("lead.created and other events still dispatch directly and create no outbox rows", async () => {
    statusJourney("on-created", [], tenant, "lead.created");
    statusJourney("on-status", []);
    const lead = await newLead();

    const outcomes = await dispatchJourneyEvent(deps, {
      tenantId: tenant,
      type: "lead.created",
      sourceId: lead,
      contactId: lead,
      entityType: "contact",
      entityId: lead,
      payload: { source: "manual" },
    });
    assert.deepEqual(outcomes.map((outcome) => [outcome.journeyId, outcome.result]), [["on-created", "started"]]);
    assert.equal((await rows()).length, 0);
    assert.equal((await drain()).claimed, 0);
  });
});

describe("run idempotency across journey versions", () => {
  const JOURNEY = "j-once";

  /** Trigger → wait 1 day → task, so the run stays active (waiting). */
  function waitingJourney(journeyId: string) {
    const snapshot: JourneySnapshot = {
      nodes: [
        { id: `${journeyId}-t`, type: "trigger", name: "Trigger", description: "", config: { event: "lead.status_changed", filters: [] } },
        { id: `${journeyId}-w`, type: "action", name: "Wait", description: "", config: { action: "wait", duration: 1, unit: "days" } },
        { id: `${journeyId}-a`, type: "action", name: "Task", description: "", config: { action: "create_task", title: "Follow up", notes: "", dueInDays: 1 } },
      ],
      connections: [
        { id: `${journeyId}-c1`, sourceNodeId: `${journeyId}-t`, targetNodeId: `${journeyId}-w`, sourceHandle: null, targetHandle: null },
        { id: `${journeyId}-c2`, sourceNodeId: `${journeyId}-w`, targetNodeId: `${journeyId}-a`, sourceHandle: null, targetHandle: null },
      ],
    };
    return store.saveJourney(tenant, journeyId, snapshot);
  }

  /** Drains pending rows and records each journey's dispatch result. */
  async function deliver(): Promise<string[]> {
    const outcomes: string[] = [];
    await drain(async (event) => {
      const result = await dispatchJourneyEvent(deps, event);
      outcomes.push(...result.map((entry) => entry.result));
      return result;
    });
    return outcomes;
  }

  /** The outbox delivers the same rows again (dispatcher died before marking them, or an expired claim). */
  async function redeliver(): Promise<string[]> {
    await db.query("update public.lead_status_events set dispatched_at = null");
    return deliver();
  }

  it("a status event creates one run keyed by event and journey, without a version", async () => {
    statusJourney(JOURNEY);
    const lead = await newLead();
    await setStatus(lead, "Working");
    const [row] = await rows();

    assert.deepEqual(await deliver(), ["started"]);
    assert.equal(runs().length, 1);
    assert.equal(runs()[0].idempotencyKey, `lead.status_changed:${row.id}:${JOURNEY}`);
  });

  it("delivering the same event twice: started, then duplicate", async () => {
    statusJourney(JOURNEY);
    const lead = await newLead();
    await setStatus(lead, "Working");

    assert.deepEqual(await deliver(), ["started"]);
    assert.deepEqual(await redeliver(), ["duplicate"]);
    assert.equal(runs().length, 1);
  });

  it("redelivery after the journey was saved as v2 is a duplicate; the run keeps version 1", async () => {
    statusJourney(JOURNEY);
    const lead = await newLead();
    await setStatus(lead, "Working");
    await deliver();
    assert.equal(runs()[0].status, "completed");

    statusJourney(JOURNEY);
    assert.equal(store.journeys.get(JOURNEY)!.version, 2);

    assert.deepEqual(await redeliver(), ["duplicate"]);
    assert.equal(runs().length, 1);
    assert.equal(runs()[0].journeyVersion, 1);
  });

  it("redelivery after v2, v3, and v4 is still a duplicate", async () => {
    statusJourney(JOURNEY);
    const lead = await newLead();
    await setStatus(lead, "Working");
    await deliver();

    for (let save = 0; save < 3; save++) statusJourney(JOURNEY);
    assert.equal(store.journeys.get(JOURNEY)!.version, 4);

    assert.deepEqual(await redeliver(), ["duplicate"]);
    assert.equal(runs().length, 1);
    assert.equal(runs()[0].journeyVersion, 1);
  });

  it("journey saved while its run waits: redelivery and a new event start nothing (active-run rule unchanged)", async () => {
    waitingJourney(JOURNEY);
    const lead = await newLead();
    await setStatus(lead, "Working");
    const [row] = await rows();
    await deliver();
    assert.equal(runs()[0].status, "waiting");

    waitingJourney(JOURNEY);
    // The active-run check answers before the key is tried; the key would collide anyway.
    assert.deepEqual(await redeliver(), ["already_active"]);
    assert.equal(idempotencyKey({ type: "lead.status_changed", sourceId: row.id }, JOURNEY, 2), runs()[0].idempotencyKey);
    assert.equal(runs().length, 1);
    assert.equal(runs()[0].journeyVersion, 1);

    await setStatus(lead, "Contacted");
    assert.deepEqual(await deliver(), ["already_active"]);
    assert.equal(runs().length, 1);
    assert.equal(runs()[0].status, "waiting");
  });

  it("a new event after the journey was saved starts its own run on the new version", async () => {
    statusJourney(JOURNEY);
    const lead = await newLead();
    await setStatus(lead, "Working");
    assert.deepEqual(await deliver(), ["started"]);

    statusJourney(JOURNEY);
    await setStatus(lead, "Contacted");
    assert.deepEqual(await deliver(), ["started"]);

    const [e1, e2] = await rows();
    assert.deepEqual(
      runs().map((run) => [run.idempotencyKey, run.journeyVersion]),
      [
        [`lead.status_changed:${e1.id}:${JOURNEY}`, 1],
        [`lead.status_changed:${e2.id}:${JOURNEY}`, 2],
      ],
    );
  });

  it("two workers delivering the same event at once: one started, one duplicate, one run", async () => {
    statusJourney(JOURNEY);
    const lead = await newLead();
    await setStatus(lead, "Working");
    const [claimed] = await outbox.claim({ limit: 1, leaseSeconds: 60 });
    const event = leadStatusJourneyEvent(claimed);

    const results = await Promise.all([dispatchJourneyEvent(deps, event), dispatchJourneyEvent(deps, event)]);
    assert.deepEqual(results.flat().map((entry) => entry.result).sort(), ["duplicate", "started"]);
    assert.equal(runs().length, 1);
  });

  it("two workers that see different journey versions still produce one run", async () => {
    statusJourney(JOURNEY);
    const v1 = (await store.findCandidateJourneys(tenant, "lead.status_changed"))[0];
    statusJourney(JOURNEY);
    const lead = await newLead();
    await setStatus(lead, "Working");
    const [claimed] = await outbox.claim({ limit: 1, leaseSeconds: 60 });
    const event = leadStatusJourneyEvent(claimed);

    assert.equal(idempotencyKey(event, JOURNEY, 1), idempotencyKey(event, JOURNEY, 2));

    // A worker that loaded the journey before the save still sees v1.
    const staleStore = new Proxy(store, {
      get(target, property) {
        if (property === "findCandidateJourneys") return async () => [v1];
        const value = Reflect.get(target, property, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const results = await Promise.all([
      dispatchJourneyEvent({ ...deps, store: staleStore }, event),
      dispatchJourneyEvent(deps, event),
    ]);
    assert.deepEqual(results.flat().map((entry) => entry.result).sort(), ["duplicate", "started"]);
    assert.equal(runs().length, 1);
  });

  it("different events for the same journey run independently", async () => {
    statusJourney(JOURNEY);
    const a = await newLead();
    const b = await newLead();
    await setStatus(a, "Working");
    await setStatus(b, "Working");
    assert.deepEqual(await deliver(), ["started", "started"]);

    await setStatus(a, "Contacted");
    assert.deepEqual(await deliver(), ["started"]);
    assert.equal(runs().length, 3);
    assert.equal(new Set(runs().map((run) => run.idempotencyKey)).size, 3);
  });

  it("other journey events keep the versioned key", () => {
    for (const type of ["lead.created", "manual", "message.received", "appointment.booked", "task.completed"] as const) {
      const event = { type, sourceId: "src-1" };
      assert.equal(idempotencyKey(event, JOURNEY, 1), `${type}:src-1:${JOURNEY}:v1`);
      assert.equal(idempotencyKey(event, JOURNEY, 2), `${type}:src-1:${JOURNEY}:v2`);
    }
    assert.equal(idempotencyKey({ type: "lead.status_changed", sourceId: "src-1" }, JOURNEY, 7), `lead.status_changed:src-1:${JOURNEY}`);
  });
});

describe("journey_runs uniqueness (tenant_id, idempotency_key) in Postgres", () => {
  const insertRun = (tenantId: string, journeyId: string, version: number, key: string) =>
    db.query(
      "insert into public.journey_runs (tenant_id, journey_id, trigger_event, journey_version, idempotency_key) values ($1, $2, 'lead.status_changed', $3, $4)",
      [tenantId, journeyId, version, key],
    );
  const event = (sourceId: string) => ({ type: "lead.status_changed" as const, sourceId });

  it("a second run for the same status event and journey is rejected even at a different journey_version", async () => {
    const journeyId = randomUUID();
    const eventId = randomUUID();
    await insertRun(tenant, journeyId, 1, idempotencyKey(event(eventId), journeyId, 1));
    await assert.rejects(
      insertRun(tenant, journeyId, 2, idempotencyKey(event(eventId), journeyId, 2)),
      (error: { code?: string }) => error.code === "23505",
    );
    const [{ count }] = await db.query<{ count: number }>("select count(*)::int as count from public.journey_runs");
    assert.equal(count, 1);
  });

  it("other events, journeys, and workspaces are not blocked", async () => {
    const journeyId = randomUUID();
    const eventId = randomUUID();
    const otherTenant = await newTenant();
    await insertRun(tenant, journeyId, 1, idempotencyKey(event(eventId), journeyId, 1));
    await insertRun(tenant, journeyId, 2, idempotencyKey(event(randomUUID()), journeyId, 2));
    const otherJourney = randomUUID();
    await insertRun(tenant, otherJourney, 1, idempotencyKey(event(eventId), otherJourney, 1));
    await insertRun(otherTenant, journeyId, 1, idempotencyKey(event(eventId), journeyId, 1));
  });

  it("deployment transition: a run keyed the old way (…:v1) does not collide with the new key", async () => {
    const journeyId = randomUUID();
    const eventId = randomUUID();
    const legacyKey = `lead.status_changed:${eventId}:${journeyId}:v1`;
    const newKey = idempotencyKey(event(eventId), journeyId, 1);
    assert.equal(newKey, `lead.status_changed:${eventId}:${journeyId}`);
    assert.notEqual(newKey, legacyKey);

    // A row redelivered after the deploy whose run was created before it is not deduplicated by the key.
    await insertRun(tenant, journeyId, 1, legacyKey);
    await insertRun(tenant, journeyId, 1, newKey);
    const [{ count }] = await db.query<{ count: number }>("select count(*)::int as count from public.journey_runs");
    assert.equal(count, 2);
  });
});

describe("journey-originated status changes", () => {
  // Journey A: New → Working, then Update lead → Qualified. B listens for Qualified, C for any change.
  // A also matches any change here, so only the origin exclusion keeps it from re-enrolling.
  let journeyA: string;
  let journeyB: string;
  let journeyC: string;

  beforeEach(() => {
    journeyA = randomUUID();
    journeyB = randomUUID();
    journeyC = randomUUID();
    statusJourney(journeyA, []);
    statusJourney(journeyB, [to("Qualified")]);
    statusJourney(journeyC, []);
  });

  async function runOf(journeyId: string, tenantId = tenant): Promise<string> {
    const [row] = await db.query<{ id: string }>(
      "insert into public.journey_runs (tenant_id, journey_id) values ($1, $2) returning id",
      [tenantId, journeyId],
    );
    return row.id;
  }

  /** Same write as live-actions' Update lead store: service role, journey origin, run id. */
  async function journeySetsStatus(contactId: string, status: string, runId: string) {
    const { error } = await withStatusOrigin(
      db.client("service_role").from("contacts").update({ lead_status: status }).eq("id", contactId).eq("tenant_id", tenant),
      { origin: "journey", originRunId: runId },
    );
    assert.equal(error, null);
    store.contacts.get(contactId)!.lead.lead_status = status;
  }

  const startedJourneys = () => runs().map((run) => run.journeyId).sort();

  it("records origin journey with the run id and dispatches the row normally", async () => {
    const lead = await newLead(tenant, "Working");
    const runA = await runOf(journeyA);
    await journeySetsStatus(lead, "Qualified", runA);

    const [pending] = await db.query<{ origin: string; origin_run_id: string }>("select origin, origin_run_id from public.lead_status_events");
    assert.equal(pending.origin, "journey");
    assert.equal(pending.origin_run_id, runA);

    assert.deepEqual(await drain(), { claimed: 1, delivered: 1, depthLimited: 0, failed: 0, permanentlyFailed: 0 });
    const [row] = await rows();
    assert.ok(row.dispatched_at);
    assert.equal(row.last_error, null);
  });

  it("reaches other eligible journeys (to=Qualified and any change) but never the originating journey", async () => {
    const lead = await newLead(tenant, "Working");
    await journeySetsStatus(lead, "Qualified", await runOf(journeyA));

    const delivered: JourneyEvent[] = [];
    const outcomes: string[] = [];
    await drain(async (event) => {
      delivered.push(event);
      const result = await dispatchJourneyEvent(deps, event);
      outcomes.push(...result.map((entry) => `${entry.journeyId}:${entry.result}`));
      return result;
    });

    assert.equal(delivered[0].excludeJourneyId, journeyA);
    assert.deepEqual(startedJourneys(), [journeyB, journeyC].sort());
    assert.ok(!outcomes.some((outcome) => outcome.startsWith(journeyA)), "A is not even a candidate");
  });

  it("excluding the originating journey is per event: a later non-journey change reaches A again", async () => {
    const lead = await newLead(tenant, "Working");
    await journeySetsStatus(lead, "Qualified", await runOf(journeyA));
    await drain();
    await setStatus(lead, "Contacted");
    await drain();

    assert.equal(runs().filter((run) => run.journeyId === journeyA).length, 1);
    assert.equal(runs().filter((run) => run.journeyId === journeyC).length, 2);
  });

  it("redelivering the same journey-originated row creates no new runs and still skips A", async () => {
    const lead = await newLead(tenant, "Working");
    await journeySetsStatus(lead, "Qualified", await runOf(journeyA));
    await drain();
    const [row] = await rows();
    const keys = runs().map((run) => run.idempotencyKey).sort();
    assert.deepEqual(keys, [`lead.status_changed:${row.id}:${journeyB}`, `lead.status_changed:${row.id}:${journeyC}`].sort());

    await db.query("update public.lead_status_events set dispatched_at = null");
    await drain();
    assert.deepEqual(runs().map((run) => run.idempotencyKey).sort(), keys);
  });

  it("a failed delivery stays pending and the retry reaches B and C, not A", async () => {
    const lead = await newLead(tenant, "Working");
    await journeySetsStatus(lead, "Qualified", await runOf(journeyA));

    assert.deepEqual(await drain(async () => { throw new Error("temporary outage"); }), { claimed: 1, delivered: 0, depthLimited: 0, failed: 1, permanentlyFailed: 0 });
    let [row] = await rows();
    assert.equal(row.dispatched_at, null);
    assert.equal(row.attempt_count, 1);
    assert.deepEqual(runs(), []);

    await db.query("update public.lead_status_events set next_attempt_at = now()");
    assert.deepEqual(await drain(), { claimed: 1, delivered: 1, depthLimited: 0, failed: 0, permanentlyFailed: 0 });
    [row] = await rows();
    assert.ok(row.dispatched_at);
    assert.deepEqual(startedJourneys(), [journeyB, journeyC].sort());
  });

  it("if the originating run can't be looked up, the row fails and stays pending rather than reaching A", async () => {
    const lead = await newLead(tenant, "Working");
    await journeySetsStatus(lead, "Qualified", await runOf(journeyA));

    await db.query("revoke select on public.journey_runs from service_role");
    try {
      const summary = await drain();
      assert.deepEqual(summary, { claimed: 1, delivered: 0, depthLimited: 0, failed: 1, permanentlyFailed: 0 });
    } finally {
      await db.query("grant select on public.journey_runs to service_role");
    }
    const [row] = await rows();
    assert.equal(row.dispatched_at, null);
    assert.match(row.last_error ?? "", /origin run lookup/);
    assert.deepEqual(runs(), []);
  });

  it("a run id from another workspace or an unknown run excludes nothing", async () => {
    const otherTenant = await newTenant();
    const lead = await newLead(tenant, "Working");
    await journeySetsStatus(lead, "Qualified", await runOf(journeyA, otherTenant));
    await setStatus(lead, "Working");
    await journeySetsStatus(lead, "Qualified", randomUUID());
    await drain();

    assert.equal(runs().filter((run) => run.journeyId === journeyA).length, 3);
  });
});
