/**
 * Causation depth for journey → status change → journey chains. Real trigger and
 * outbox (migration 055 on PGlite), real dispatchJourneyEvent and executeRun, and
 * real executeUpdateLead writing status through supabase-js with the journey
 * origin headers, exactly like live-actions. Runs live in the memory store and
 * are mirrored into journey_runs (uuid id, journey, trigger event and payload),
 * which is what the dispatcher reads.
 */

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, beforeEach, describe, it } from "node:test";
import { withStatusOrigin } from "../../crm/status-origin.ts";
import type { JourneyAIExecutor } from "./ai.ts";
import type { ConditionRule } from "./contracts.ts";
import {
  dispatchJourneyEvent,
  MAX_JOURNEY_CAUSATION_DEPTH,
  type ActionExecutor,
  type EngineDeps,
  type JourneyEvent,
} from "./engine.ts";
import type { JourneySnapshot, SnapshotNode } from "./graph.ts";
import {
  createSupabaseLeadStatusOutbox,
  DEFAULT_OUTBOX_OPTIONS,
  dispatchLeadStatusEvents,
  runCausationDepth,
  type LeadStatusOutbox,
  type OutboxDispatchSummary,
} from "./lead-status-outbox.ts";
import { createTestDb, type TestDb } from "./lead-status-test-db.ts";
import { MemoryJourneyStore, type MemoryRun } from "./memory-store.ts";
import { executeUpdateLead } from "./update-lead.ts";

let db: TestDb;
let tenant: string;
let store: MemoryJourneyStore;
let deps: EngineDeps;
let outbox: LeadStatusOutbox;
/** Memory run id → the uuid it has in journey_runs. */
let runUuid: Map<string, string>;
/** Journey uuid → readable name. */
let names: Map<string, string>;
let tasks: string[];
let logs: string[];

const ai: JourneyAIExecutor = { execute: async () => ({ success: true, output: {}, text: "" }) };
const USER = randomUUID();

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
  runUuid = new Map();
  names = new Map();
  tasks = [];
  logs = [];
  outbox = createSupabaseLeadStatusOutbox(db.client("service_role"));

  const createRun = store.createRun.bind(store);
  store.createRun = async (input) => {
    const result = await createRun(input);
    if (result.created) {
      const id = randomUUID();
      runUuid.set(result.run.id, id);
      await db.query(
        "insert into public.journey_runs (id, tenant_id, journey_id, trigger_event, trigger_payload) values ($1, $2, $3, $4, $5)",
        [id, input.tenantId, input.journeyId, input.triggerEvent, JSON.stringify(input.triggerPayload)],
      );
    }
    return result;
  };

  const admin = db.client("service_role");
  const actions: ActionExecutor = {
    async execute(action, input) {
      if (action.action === "update_lead") {
        return executeUpdateLead(action, input, {
          async updateFields(tenantId, contactId, patch, runId) {
            const { data, error } = await withStatusOrigin(
              admin.from("contacts").update(patch).eq("id", contactId).eq("tenant_id", tenantId).select("id"),
              { origin: "journey", originRunId: runUuid.get(runId) },
            );
            if (!error && data?.length) Object.assign(store.contacts.get(contactId)!.lead, patch);
            return { error: error?.message ?? null, matched: (data?.length ?? 0) > 0 };
          },
          async convertLeadToClient() {
            return { error: null, matched: true };
          },
          async logActivity() {},
        });
      }
      tasks.push(`${names.get(input.nodeId.split(":")[0]) ?? "?"}:${action.action}`);
      return { status: "completed", output: {} };
    },
  };
  deps = { store, actions, ai };
});

async function newTenant(): Promise<string> {
  const [row] = await db.query<{ id: string }>("insert into public.tenants default values returning id");
  return row.id;
}

async function newLead(status = "New", tenantId = tenant): Promise<string> {
  const [row] = await db.query<{ id: string }>(
    "insert into public.contacts (tenant_id, lead_status) values ($1, $2) returning id",
    [tenantId, status],
  );
  store.contacts.set(row.id, { tenantId, lead: { lead_status: status, record_type: "lead" } });
  return row.id;
}

/** A team member changes the status in the CRM (signed-in client). */
async function userSetsStatus(contactId: string, status: string) {
  const { error } = await db
    .client("authenticated", USER)
    .from("contacts")
    .update({ lead_status: status })
    .eq("id", contactId)
    .eq("tenant_id", tenant);
  assert.equal(error, null);
  store.contacts.get(contactId)!.lead.lead_status = status;
}

/** A status write made by a given journey run (service role, journey origin). */
async function journeyRunSetsStatus(contactId: string, status: string, runId: string) {
  const { error } = await withStatusOrigin(
    db.client("service_role").from("contacts").update({ lead_status: status }).eq("id", contactId),
    { origin: "journey", originRunId: runId },
  );
  assert.equal(error, null);
  store.contacts.get(contactId)!.lead.lead_status = status;
}

const to = (value: string): ConditionRule => ({ field: "trigger.to_status", operator: "equals", value });
const setStatus = (status: string) => ({ action: "update_lead", fields: { lead_status: status } });
const task = { action: "create_task", title: "Follow up", notes: "", dueInDays: 1 };

/** Trigger (lead.status_changed unless given) → actions in order. Node ids are `<journey>:<n>`. */
function journey(name: string, filters: ConditionRule[], steps: Record<string, unknown>[], event = "lead.status_changed") {
  const id = randomUUID();
  names.set(id, name);
  const nodes: SnapshotNode[] = [
    { id: `${id}:t`, type: "trigger", name: "Trigger", description: "", config: { event, filters } },
    ...steps.map((config, index): SnapshotNode => ({ id: `${id}:${index}`, type: "action", name: `Step ${index}`, description: "", config })),
  ];
  const snapshot: JourneySnapshot = {
    nodes,
    connections: nodes.slice(1).map((node, index) => ({
      id: `${id}:c${index}`,
      sourceNodeId: nodes[index].id,
      targetNodeId: node.id,
      sourceHandle: null,
      targetHandle: null,
    })),
  };
  store.saveJourney(tenant, id, snapshot);
  return id;
}

async function drain(dispatch: (event: JourneyEvent) => Promise<unknown> = (event) => dispatchJourneyEvent(deps, event)) {
  return dispatchLeadStatusEvents(outbox, dispatch, { ...DEFAULT_OUTBOX_OPTIONS, budgetMs: 60_000 }, Date.now, (message) => logs.push(message));
}

/** Delivers until nothing is pending (each delivery may run journeys that change status again). */
async function drainAll(): Promise<OutboxDispatchSummary> {
  const total: OutboxDispatchSummary = { claimed: 0, delivered: 0, depthLimited: 0, failed: 0, permanentlyFailed: 0 };
  for (let round = 0; round < 20; round++) {
    const summary = await drain();
    if (summary.claimed === 0) return total;
    for (const key of Object.keys(total) as (keyof OutboxDispatchSummary)[]) total[key] += summary[key];
  }
  throw new Error("Outbox never drained: unbounded chain");
}

const runs = (): MemoryRun[] => [...store.runs.values()];
const depth = (run: MemoryRun) => runCausationDepth({ triggerEvent: run.triggerEvent, triggerPayload: run.triggerPayload });
/** "<journey> d<depth>" per run, in creation order. */
const chain = () => runs().map((run) => `${names.get(run.journeyId)} d${depth(run)}`);

async function outboxRows() {
  return db.query<{ id: string; origin: string; to_status: string; dispatched_at: Date | null; attempt_count: number; last_error: string | null }>(
    "select id, origin, to_status, dispatched_at, attempt_count, last_error from public.lead_status_events order by created_at, id",
  );
}

describe("causation depth", () => {
  it("the limit is 3 journey hops", () => {
    assert.equal(MAX_JOURNEY_CAUSATION_DEPTH, 3);
  });

  it("an outside change starts a normal A → B → C chain, each run one level deeper", async () => {
    journey("A", [to("Working")], [setStatus("Qualified")]);
    journey("B", [to("Qualified")], [setStatus("Contacted")]);
    journey("C", [to("Contacted")], [task]);
    const lead = await newLead("New");

    await userSetsStatus(lead, "Working");
    const summary = await drainAll();

    assert.deepEqual(chain(), ["A d1", "B d2", "C d3"]);
    assert.deepEqual(tasks, ["C:create_task"]);
    assert.equal(summary.depthLimited, 0);
  });

  it("boundary: events at depth 0, 1, 2 start runs at 1, 2, 3; the depth-3 event starts nothing (depth 4 never exists)", async () => {
    journey("J1", [to("Working")], [setStatus("Contacted")]);
    journey("J2", [to("Contacted")], [setStatus("Qualified")]);
    journey("J3", [to("Qualified")], [setStatus("Converted")]);
    const j4 = journey("J4", [to("Converted")], [task]);
    const lead = await newLead("New");

    await userSetsStatus(lead, "Working");
    const summary = await drainAll();

    assert.deepEqual(chain(), ["J1 d1", "J2 d2", "J3 d3"]);
    assert.deepEqual(runs().map((run) => run.triggerPayload.causation_depth), [0, 1, 2]);
    assert.ok(!runs().some((run) => run.journeyId === j4), "J4 would be depth 4");
    assert.deepEqual(tasks, []);

    // Every event is recorded and dispatched, including the one that started nothing.
    const rows = await outboxRows();
    assert.deepEqual(rows.map((row) => [row.origin, row.to_status]), [
      ["user", "Working"],
      ["journey", "Contacted"],
      ["journey", "Qualified"],
      ["journey", "Converted"],
    ]);
    assert.ok(rows.every((row) => row.dispatched_at && row.attempt_count === 1 && row.last_error === null));
    assert.deepEqual(summary, { claimed: 4, delivered: 4, depthLimited: 1, failed: 0, permanentlyFailed: 0 });
    assert.equal(logs.length, 1);
    assert.match(logs[0], new RegExp(`${rows[3].id}.*causation depth 3 reached the limit of 3`));
  });

  it("A → B → A runs A again only within the limit, then stops", async () => {
    journey("A", [to("Working")], [setStatus("Qualified")]);
    journey("B", [to("Qualified")], [setStatus("Working")]);
    const lead = await newLead("New");

    await userSetsStatus(lead, "Working");
    const summary = await drainAll();

    assert.deepEqual(chain(), ["A d1", "B d2", "A d3"]);
    assert.equal(summary.depthLimited, 1);
  });

  it("A → B → C → A is bounded: C's change can't start A at depth 4", async () => {
    journey("A", [to("Working")], [setStatus("Qualified")]);
    journey("B", [to("Qualified")], [setStatus("Contacted")]);
    journey("C", [to("Contacted")], [setStatus("Working")]);
    const lead = await newLead("New");

    await userSetsStatus(lead, "Working");
    await drainAll();

    assert.deepEqual(chain(), ["A d1", "B d2", "C d3"]);
  });

  it("every other eligible journey reacts to a journey's change; only the originating journey is excluded", async () => {
    journey("A", [], [setStatus("Qualified")], "lead.created");
    journey("B", [to("Qualified")], [task]);
    journey("C", [to("Qualified")], [task]);
    journey("D", [], [task]);
    const lead = await newLead("Working");

    await dispatchJourneyEvent(deps, { tenantId: tenant, type: "lead.created", sourceId: lead, contactId: lead, entityType: "contact", entityId: lead, payload: {} });
    await drainAll();

    assert.deepEqual(chain().sort(), ["A d1", "B d2", "C d2", "D d2"]);
  });

  it("the originating journey stays excluded even with depth to spare", async () => {
    journey("A", [], [setStatus("Qualified")]);
    const lead = await newLead("New");

    await userSetsStatus(lead, "Working");
    await drainAll();

    assert.deepEqual(chain(), ["A d1"]);
  });

  it("non-status actions don't add depth; only a status change made by a run does", async () => {
    journey("A", [to("Working")], [task, task, setStatus("Qualified"), task]);
    journey("B", [to("Qualified")], [task]);
    const lead = await newLead("New");

    await userSetsStatus(lead, "Working");
    await drainAll();

    assert.deepEqual(chain(), ["A d1", "B d2"]);
    assert.deepEqual(tasks, ["A:create_task", "A:create_task", "A:create_task", "B:create_task"]);
  });

  it("a run started by another kind of event (lead.created) is depth 1", async () => {
    journey("Intake", [], [setStatus("Working")], "lead.created");
    journey("Next", [to("Working")], [task]);
    const lead = await newLead("New");

    await dispatchJourneyEvent(deps, { tenantId: tenant, type: "lead.created", sourceId: lead, contactId: lead, entityType: "contact", entityId: lead, payload: {} });
    await drainAll();

    assert.deepEqual(chain(), ["Intake d1", "Next d2"]);
  });

  it("a team member's change after a stopped chain starts a fresh chain at depth 1", async () => {
    journey("A", [to("Working")], [setStatus("Qualified")]);
    journey("B", [to("Qualified")], [setStatus("Working")]);
    const lead = await newLead("New");

    await userSetsStatus(lead, "Working");
    await drainAll();
    assert.deepEqual(chain(), ["A d1", "B d2", "A d3"]);

    await userSetsStatus(lead, "Contacted");
    await userSetsStatus(lead, "Working");
    await drainAll();
    assert.deepEqual(chain(), ["A d1", "B d2", "A d3", "A d1", "B d2", "A d3"]);
  });

  it("redelivering every event of a finished chain creates no runs", async () => {
    journey("A", [to("Working")], [setStatus("Qualified")]);
    journey("B", [to("Qualified")], [setStatus("Working")]);
    const lead = await newLead("New");
    await userSetsStatus(lead, "Working");
    await drainAll();
    const before = chain();

    await db.query("update public.lead_status_events set dispatched_at = null");
    const summary = await drainAll();

    assert.deepEqual(chain(), before);
    assert.equal(summary.delivered, 4);
    assert.equal(summary.depthLimited, 1);
  });

  it("a failed delivery stays pending and the retry keeps the same depth", async () => {
    journey("A", [to("Working")], [setStatus("Qualified")]);
    journey("B", [to("Qualified")], [task]);
    const lead = await newLead("New");
    await userSetsStatus(lead, "Working");
    await drain();
    assert.deepEqual(chain(), ["A d1"]);

    const failing = await drain(async () => {
      throw new Error("temporary outage");
    });
    assert.deepEqual(failing, { claimed: 1, delivered: 0, depthLimited: 0, failed: 1, permanentlyFailed: 0 });
    const pending = (await outboxRows())[1];
    assert.equal(pending.dispatched_at, null);
    assert.equal(pending.attempt_count, 1);

    await db.query("update public.lead_status_events set next_attempt_at = now()");
    await drainAll();
    assert.deepEqual(chain(), ["A d1", "B d2"]);
    assert.equal(runs()[1].triggerPayload.causation_depth, 1);
  });
});

describe("causation metadata integrity", () => {
  async function storedRun(tenantId: string, triggerEvent: string, triggerPayload: Record<string, unknown>) {
    const id = randomUUID();
    await db.query(
      "insert into public.journey_runs (id, tenant_id, journey_id, trigger_event, trigger_payload) values ($1, $2, $3, $4, $5)",
      [id, tenantId, randomUUID(), triggerEvent, JSON.stringify(triggerPayload)],
    );
    return id;
  }

  /** Depth recorded on the run that a change made by `originRunId` starts. */
  async function depthStartedBy(originRunId: string): Promise<number | null> {
    journey("Listener", [], [task]);
    const lead = await newLead("New");
    await journeyRunSetsStatus(lead, "Working", originRunId);
    await drainAll();
    const run = runs().find((entry) => names.get(entry.journeyId) === "Listener");
    return run ? depth(run) : null;
  }

  it("a run in another workspace can't lend its depth (or its journey) to this workspace's event", async () => {
    const other = await newTenant();
    const foreign = await storedRun(other, "lead.status_changed", { causation_depth: 2 });
    assert.equal(await depthStartedBy(foreign), 1);
  });

  it("an unknown origin run starts from the outside-change baseline", async () => {
    assert.equal(await depthStartedBy(randomUUID()), 1);
  });

  it("a status-triggered run with no recorded depth (pre-existing data) counts as depth 1", async () => {
    assert.equal(await depthStartedBy(await storedRun(tenant, "lead.status_changed", {})), 2);
  });

  for (const malformed of ["0", -5, 1.5, null, { nested: 1 }]) {
    it(`a malformed recorded depth (${JSON.stringify(malformed)}) counts as depth 1, never lower`, async () => {
      assert.equal(await depthStartedBy(await storedRun(tenant, "lead.status_changed", { causation_depth: malformed })), 2);
    });
  }

  it("depth recorded on a run that wasn't started by a status change is ignored", async () => {
    assert.equal(await depthStartedBy(await storedRun(tenant, "manual", { causation_depth: 99 })), 2);
  });

  it("a recorded depth at or past the limit starts nothing", async () => {
    assert.equal(await depthStartedBy(await storedRun(tenant, "lead.status_changed", { causation_depth: 2 })), null);
    assert.equal(logs.length, 1);
  });

  it("a signed-in user can't attach a journey run (or its depth) to their change", async () => {
    const deep = await storedRun(tenant, "lead.status_changed", { causation_depth: 2 });
    journey("Listener", [], [task]);
    const lead = await newLead("New");
    const { error } = await db
      .client("authenticated", USER)
      .from("contacts")
      .update({ lead_status: "Working" })
      .eq("id", lead)
      .setHeader("x-reos-origin", "journey")
      .setHeader("x-reos-origin-run-id", deep)
      .setHeader("x-reos-causation-depth", "0");
    assert.equal(error, null);
    store.contacts.get(lead)!.lead.lead_status = "Working";
    await drainAll();

    const [row] = await db.query<{ origin: string; origin_run_id: string | null }>("select origin, origin_run_id from public.lead_status_events");
    assert.deepEqual(row, { origin: "user", origin_run_id: null });
    assert.deepEqual(chain(), ["Listener d1"]);
  });

  it("runCausationDepth: only lead.status_changed runs inherit depth", () => {
    assert.equal(runCausationDepth({ triggerEvent: "lead.status_changed", triggerPayload: { causation_depth: 0 } }), 1);
    assert.equal(runCausationDepth({ triggerEvent: "lead.status_changed", triggerPayload: { causation_depth: 2 } }), 3);
    assert.equal(runCausationDepth({ triggerEvent: "message.received", triggerPayload: { causation_depth: 2 } }), 1);
    assert.equal(runCausationDepth({ triggerEvent: "lead.status_changed", triggerPayload: {} }), 1);
  });
});
