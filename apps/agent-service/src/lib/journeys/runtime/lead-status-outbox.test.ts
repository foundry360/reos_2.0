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
      { event_id: row.id, from_status: "New", to_status: "Working", origin: "system", actor_user_id: null, origin_run_id: null, converted: false, changed_at: undefined },
    );
    const [run] = runs();
    assert.equal(run.idempotencyKey, `lead.status_changed:${row.id}:j-any:v1`);
  });

  it("marks a delivered row dispatched and releases its claim", async () => {
    statusJourney("j-any");
    const lead = await newLead();
    await setStatus(lead, "Working");

    const summary = await drain();
    assert.deepEqual(summary, { claimed: 1, delivered: 1, failed: 0 });
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

    await outbox.fail(stale, "late failure");
    await outbox.complete(stale);
    let [row] = await rows();
    assert.equal(row.dispatched_at, null);
    assert.equal(row.attempt_count, 0);

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
    assert.deepEqual(summary, { claimed: 1, delivered: 0, failed: 1 });
    let [row] = await rows();
    assert.equal(row.dispatched_at, null);
    assert.equal(row.attempt_count, 1);
    assert.equal(row.last_error, "database unavailable");
    assert.equal(row.claim_token, null);
    assert.ok(row.next_attempt_at.getTime() > Date.now());
    assert.equal((await drain()).claimed, 0, "not retried before the backoff");

    await db.query("update public.lead_status_events set next_attempt_at = now()");
    assert.deepEqual(await drain(), { claimed: 1, delivered: 1, failed: 0 });
    [row] = await rows();
    assert.ok(row.dispatched_at);
    assert.equal(row.last_error, null);
    assert.equal(row.attempt_count, 1);
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
    assert.deepEqual(summary, { claimed: 2, delivered: 1, failed: 1 });
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

    assert.deepEqual(await drain(), { claimed: 1, delivered: 1, failed: 0 });
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
    assert.deepEqual(keys, [`lead.status_changed:${row.id}:${journeyB}:v1`, `lead.status_changed:${row.id}:${journeyC}:v1`].sort());

    await db.query("update public.lead_status_events set dispatched_at = null");
    await drain();
    assert.deepEqual(runs().map((run) => run.idempotencyKey).sort(), keys);
  });

  it("a failed delivery stays pending and the retry reaches B and C, not A", async () => {
    const lead = await newLead(tenant, "Working");
    await journeySetsStatus(lead, "Qualified", await runOf(journeyA));

    assert.deepEqual(await drain(async () => { throw new Error("temporary outage"); }), { claimed: 1, delivered: 0, failed: 1 });
    let [row] = await rows();
    assert.equal(row.dispatched_at, null);
    assert.equal(row.attempt_count, 1);
    assert.deepEqual(runs(), []);

    await db.query("update public.lead_status_events set next_attempt_at = now()");
    assert.deepEqual(await drain(), { claimed: 1, delivered: 1, failed: 0 });
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
      assert.deepEqual(summary, { claimed: 1, delivered: 0, failed: 1 });
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
