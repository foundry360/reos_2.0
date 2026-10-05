/**
 * Lineage (origin_journey_id, origin_run_id, root_run_id) on lead.status_changed
 * payloads, and the shared causation-depth guard. Real trigger and outbox
 * (migration 055 on PGlite), real dispatchJourneyEvent and executeRun, and real
 * executeUpdateLead writing status with the journey origin headers. Runs live in
 * the memory store and are mirrored into journey_runs, which the dispatcher reads.
 */

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, beforeEach, describe, it } from "node:test";
import { withStatusOrigin } from "../../crm/status-origin.ts";
import type { JourneyAIExecutor } from "./ai.ts";
import type { ConditionRule } from "./contracts.ts";
import {
  dispatchJourneyEvent,
  isCausationDepthLimited,
  JourneyStepError,
  MAX_JOURNEY_CAUSATION_DEPTH,
  resumeDueRuns,
  type ActionExecutor,
  type EngineDeps,
  type JourneyEvent,
} from "./engine.ts";
import type { JourneySnapshot, SnapshotNode } from "./graph.ts";
import {
  createSupabaseLeadStatusOutbox,
  DEFAULT_OUTBOX_OPTIONS,
  dispatchLeadStatusEvents,
  leadStatusJourneyEvent,
  leadStatusLineage,
  runCausationDepth,
  type LeadStatusEventRow,
  type LeadStatusOutbox,
  type OutboxDispatchSummary,
} from "./lead-status-outbox.ts";
import { createTestDb, type TestDb } from "./lead-status-test-db.ts";
import { MemoryJourneyStore, type MemoryRun } from "./memory-store.ts";
import { retryJourneyRun, type RunRetryLookups } from "./run-retry.ts";
import { executeUpdateLead } from "./update-lead.ts";

let db: TestDb;
let tenant: string;
let store: MemoryJourneyStore;
let deps: EngineDeps;
let outbox: LeadStatusOutbox;
/** Memory run id → the uuid it has in journey_runs. */
let runUuid: Map<string, string>;
let names: Map<string, string>;
let logs: string[];
/** Every event handed to dispatch, in order. */
let delivered: JourneyEvent[];
let failNextUpdate: Set<string>;

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
  logs = [];
  delivered = [];
  failNextUpdate = new Set();
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
        const journeyName = names.get(input.nodeId.split(":")[0]) ?? "?";
        if (failNextUpdate.delete(journeyName)) throw new JourneyStepError("CRM rejected the update.", "config");
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
      return { status: "completed", output: {} };
    },
  };
  deps = { store, actions, ai };
});

async function newTenant(): Promise<string> {
  const [row] = await db.query<{ id: string }>("insert into public.tenants default values returning id");
  return row.id;
}

async function newLead(status = "New"): Promise<string> {
  const [row] = await db.query<{ id: string }>(
    "insert into public.contacts (tenant_id, lead_status) values ($1, $2) returning id",
    [tenant, status],
  );
  store.contacts.set(row.id, { tenantId: tenant, lead: { lead_status: status, record_type: "lead" } });
  return row.id;
}

async function userSetsStatus(contactId: string, status: string) {
  const { error } = await db.client("authenticated", USER).from("contacts").update({ lead_status: status }).eq("id", contactId).eq("tenant_id", tenant);
  assert.equal(error, null);
  store.contacts.get(contactId)!.lead.lead_status = status;
}

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

async function drain() {
  return dispatchLeadStatusEvents(
    outbox,
    (event) => {
      delivered.push(structuredClone(event));
      return dispatchJourneyEvent(deps, event);
    },
    { ...DEFAULT_OUTBOX_OPTIONS, budgetMs: 60_000 },
    Date.now,
    (message) => logs.push(message),
  );
}

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
const uuidOf = (run: MemoryRun) => runUuid.get(run.id)!;

/** The lineage keys of a run's trigger payload (absent keys stay absent). */
function lineageOf(run: MemoryRun) {
  const { origin_journey_id, origin_run_id, root_run_id, causation_depth } = run.triggerPayload;
  return { origin_journey_id, origin_run_id, root_run_id, causation_depth };
}

/** The event the dispatcher builds for the latest outbox row, whether or not it was depth-limited. */
async function eventForLatestRow(): Promise<JourneyEvent> {
  const [row] = await db.query<LeadStatusEventRow>("select * from public.lead_status_events order by created_at desc, id desc limit 1");
  const origin = row.origin === "journey" && row.origin_run_id ? await outbox.originRun(row) : null;
  return leadStatusJourneyEvent(row, origin);
}

async function storedRun(tenantId: string, triggerEvent: string, triggerPayload: Record<string, unknown>, journeyId: string = randomUUID()) {
  const id = randomUUID();
  await db.query(
    "insert into public.journey_runs (id, tenant_id, journey_id, trigger_event, trigger_payload) values ($1, $2, $3, $4, $5)",
    [id, tenantId, journeyId, triggerEvent, JSON.stringify(triggerPayload)],
  );
  return id;
}

/** A Listener journey (any status change) and a change made by `originRunId`; returns Listener's run, if any. */
async function listenerRunAfterChangeBy(originRunId: string, listener = journey("Listener", [], [task])): Promise<MemoryRun | undefined> {
  const lead = await newLead("New");
  await journeyRunSetsStatus(lead, "Working", originRunId);
  await drainAll();
  return runs().find((run) => run.journeyId === listener);
}

describe("lineage: external events", () => {
  it("a team member's change is depth 0 with no origin run, origin journey, or root", async () => {
    journey("A", [to("Working")], [task]);
    const lead = await newLead("New");

    await userSetsStatus(lead, "Working");
    await drainAll();

    const [run] = runs();
    assert.deepEqual(lineageOf(run), { origin_journey_id: undefined, origin_run_id: null, root_run_id: undefined, causation_depth: 0 });
    assert.ok(!("origin_journey_id" in run.triggerPayload) && !("root_run_id" in run.triggerPayload), "the keys are absent, not null");
    assert.equal(delivered[0].excludeJourneyId, undefined);
  });

  it("the external payload is otherwise unchanged (exact key set)", async () => {
    journey("A", [to("Working")], [task]);
    const lead = await newLead("New");
    await userSetsStatus(lead, "Working");
    await drainAll();

    assert.deepEqual(Object.keys(runs()[0].triggerPayload).sort(), [
      "actor_user_id", "causation_depth", "changed_at", "converted", "event_id", "from_status", "origin", "origin_run_id", "to_status",
    ]);
  });
});

describe("lineage: journey-originated events", () => {
  it("the first journey-made change names the originating run and journey, and that run becomes the root", async () => {
    const a = journey("A", [to("Working")], [setStatus("Qualified")]);
    journey("B", [to("Qualified")], [task]);
    const lead = await newLead("New");

    await userSetsStatus(lead, "Working");
    await drainAll();

    const [runA, runB] = runs();
    assert.deepEqual(lineageOf(runB), { origin_journey_id: a, origin_run_id: uuidOf(runA), root_run_id: uuidOf(runA), causation_depth: 1 });
    assert.equal(depth(runA), 1);
    assert.equal(depth(runB), 2);
    assert.equal(delivered[1].excludeJourneyId, a);
  });

  it("a run started by another kind of event (lead.created) is the root of what it causes", async () => {
    const intake = journey("Intake", [], [setStatus("Working")], "lead.created");
    journey("Next", [to("Working")], [task]);
    const lead = await newLead("New");

    await dispatchJourneyEvent(deps, { tenantId: tenant, type: "lead.created", sourceId: lead, contactId: lead, entityType: "contact", entityId: lead, payload: {} });
    await drainAll();

    const [runIntake, runNext] = runs();
    assert.deepEqual(lineageOf(runNext), { origin_journey_id: intake, origin_run_id: uuidOf(runIntake), root_run_id: uuidOf(runIntake), causation_depth: 1 });
  });
});

describe("lineage: multi-hop chains", () => {
  it("A → B → A: the root stays A's first run, the origin run and journey follow the immediate hop, depth is independent", async () => {
    const a = journey("A", [to("Working")], [setStatus("Qualified")]);
    const b = journey("B", [to("Qualified")], [setStatus("Working")]);
    const lead = await newLead("New");

    await userSetsStatus(lead, "Working");
    const summary = await drainAll();

    const [a1, b1, a2] = runs();
    assert.deepEqual([a1, b1, a2].map((run) => names.get(run.journeyId)), ["A", "B", "A"]);
    const root = uuidOf(a1);
    assert.deepEqual(lineageOf(b1), { origin_journey_id: a, origin_run_id: uuidOf(a1), root_run_id: root, causation_depth: 1 });
    assert.deepEqual(lineageOf(a2), { origin_journey_id: b, origin_run_id: uuidOf(b1), root_run_id: root, causation_depth: 2 });
    assert.deepEqual(runs().map(depth), [1, 2, 3]);

    // A2's own change is depth-limited but still carries the same root.
    const limited = await eventForLatestRow();
    assert.deepEqual(
      { origin_journey_id: limited.payload.origin_journey_id, origin_run_id: limited.payload.origin_run_id, root_run_id: limited.payload.root_run_id, causation_depth: limited.payload.causation_depth },
      { origin_journey_id: a, origin_run_id: uuidOf(a2), root_run_id: root, causation_depth: 3 },
    );
    assert.equal(summary.depthLimited, 1);
  });

  it("a team member's change after a stopped chain starts a new root", async () => {
    journey("A", [to("Working")], [setStatus("Qualified")]);
    journey("B", [to("Qualified")], [task]);
    const lead = await newLead("New");

    await userSetsStatus(lead, "Working");
    await drainAll();
    await userSetsStatus(lead, "Contacted");
    await userSetsStatus(lead, "Working");
    await drainAll();

    const [a1, b1, a2, b2] = runs();
    assert.equal(b1.triggerPayload.root_run_id, uuidOf(a1));
    assert.equal(b2.triggerPayload.root_run_id, uuidOf(a2));
    assert.notEqual(uuidOf(a1), uuidOf(a2));
  });
});

describe("lineage across a manual run retry", () => {
  function retryLookups(): RunRetryLookups {
    return {
      async findRun(tenantId, runId) {
        const run = store.runs.get(runId);
        if (!run || run.tenantId !== tenantId) return null;
        return { journeyId: run.journeyId, contactId: run.contactId, status: run.status, currentNodeId: run.currentNodeId, context: structuredClone(run.context) };
      },
      async latestStep(tenantId, runId) {
        const step = store.steps.filter((entry) => entry.runId === runId && entry.tenantId === tenantId).at(-1);
        return step ? { nodeId: step.nodeId, nodeType: step.nodeType, status: step.status, error: step.error ?? null } : null;
      },
      journeyStatus: (tenantId, journeyId) => store.journeyStatus(tenantId, journeyId),
      hasActiveRun: (tenantId, journeyId, contactId) => store.hasActiveRun(tenantId, journeyId, contactId),
    };
  }

  it("retrying B keeps B's lineage, and C's lineage points at the same B run and the same root", async () => {
    journey("A", [to("Working")], [setStatus("Qualified")]);
    const b = journey("B", [to("Qualified")], [setStatus("Contacted")]);
    journey("C", [to("Contacted")], [task]);
    const lead = await newLead("New");
    failNextUpdate.add("B");

    await userSetsStatus(lead, "Working");
    await drainAll();
    const [runA, runB] = runs();
    assert.equal(runB.status, "failed");
    const before = structuredClone(runB.triggerPayload);

    assert.equal((await retryJourneyRun(store, retryLookups(), tenant, runB.id, new Date())).result, "retried");
    await resumeDueRuns(deps);
    await drainAll();

    assert.equal(runB.status, "completed");
    assert.deepEqual(runB.triggerPayload, before, "retry doesn't touch the trigger payload");
    assert.equal(runB.triggerPayload.root_run_id, uuidOf(runA));
    assert.equal(runB.triggerPayload.origin_run_id, uuidOf(runA));
    assert.equal(runB.triggerPayload.causation_depth, 1);

    const runC = runs()[2];
    assert.equal(names.get(runC.journeyId), "C");
    assert.deepEqual(lineageOf(runC), { origin_journey_id: b, origin_run_id: uuidOf(runB), root_run_id: uuidOf(runA), causation_depth: 2 });
  });
});

describe("lineage on redelivery", () => {
  it("redelivering every event rebuilds identical payloads and starts no runs", async () => {
    journey("A", [to("Working")], [setStatus("Qualified")]);
    journey("B", [to("Qualified")], [task]);
    const lead = await newLead("New");
    await userSetsStatus(lead, "Working");
    await drainAll();
    const first = delivered.map((event) => event.payload);
    const runCount = runs().length;

    await db.query("update public.lead_status_events set dispatched_at = null");
    delivered = [];
    const summary = await drainAll();

    assert.deepEqual(delivered.map((event) => event.payload), first);
    assert.equal(runs().length, runCount);
    assert.equal(summary.delivered, 2);
  });
});

describe("lineage: workspace scoping and unresolved origins", () => {
  it("a run in another workspace supplies no lineage, no depth, and no exclusion", async () => {
    const listener = journey("Listener", [], [task]);
    const other = await newTenant();
    // Same journey id as this workspace's Listener, deep depth, and a root: none of it may leak.
    const foreign = await storedRun(other, "lead.status_changed", { causation_depth: 2, root_run_id: randomUUID(), origin_journey_id: randomUUID() }, listener);

    const run = await listenerRunAfterChangeBy(foreign, listener);

    assert.ok(run, "not excluded by the foreign run's journey");
    assert.deepEqual(lineageOf(run), { origin_journey_id: undefined, origin_run_id: foreign, root_run_id: undefined, causation_depth: 0 });
  });

  it("an unknown origin run supplies no lineage (origin_run_id is kept as recorded)", async () => {
    const missing = randomUUID();
    const run = await listenerRunAfterChangeBy(missing);
    assert.ok(run);
    assert.deepEqual(lineageOf(run), { origin_journey_id: undefined, origin_run_id: missing, root_run_id: undefined, causation_depth: 0 });
  });
});

describe("lineage: runs from before lineage existed, and malformed lineage", () => {
  it("an origin run without root_run_id becomes the root", async () => {
    const legacyJourney = randomUUID();
    const legacy = await storedRun(tenant, "lead.status_changed", { causation_depth: 0, origin_run_id: randomUUID() }, legacyJourney);
    const run = await listenerRunAfterChangeBy(legacy);
    assert.ok(run);
    assert.deepEqual(lineageOf(run), { origin_journey_id: legacyJourney, origin_run_id: legacy, root_run_id: legacy, causation_depth: 1 });
  });

  for (const malformed of ["not-a-uuid", 42, null, { id: "x" }, ""]) {
    it(`a malformed recorded root (${JSON.stringify(malformed)}) falls back to the origin run`, async () => {
      const origin = await storedRun(tenant, "lead.status_changed", { causation_depth: 0, root_run_id: malformed });
      const run = await listenerRunAfterChangeBy(origin);
      assert.ok(run);
      assert.equal(run.triggerPayload.root_run_id, origin);
      assert.equal(run.triggerPayload.causation_depth, 1);
    });
  }

  it("a root recorded on a run not started by a status change is ignored, like its depth", async () => {
    const origin = await storedRun(tenant, "manual", { root_run_id: randomUUID(), causation_depth: 2 });
    const run = await listenerRunAfterChangeBy(origin);
    assert.ok(run);
    assert.equal(run.triggerPayload.root_run_id, origin);
    assert.equal(run.triggerPayload.causation_depth, 1);
  });

  it("origin_journey_id comes from the stored run's journey, never from its payload", () => {
    const row = { origin: "journey", origin_run_id: randomUUID() } as LeadStatusEventRow;
    const journeyId = randomUUID();
    const lineage = leadStatusLineage(row, { journeyId, triggerEvent: "lead.status_changed", triggerPayload: { origin_journey_id: "forged" } });
    assert.equal(lineage?.origin_journey_id, journeyId);
  });

  it("leadStatusLineage: nothing for non-journey origins or unresolved runs", () => {
    const originRun = { journeyId: randomUUID(), triggerEvent: "lead.status_changed", triggerPayload: {} };
    assert.equal(leadStatusLineage({ origin: "user", origin_run_id: null } as LeadStatusEventRow, originRun), null);
    assert.equal(leadStatusLineage({ origin: "journey", origin_run_id: randomUUID() } as LeadStatusEventRow, null), null);
    assert.equal(leadStatusLineage({ origin: "journey", origin_run_id: null } as LeadStatusEventRow, originRun), null);
  });
});

describe("shared causation-depth guard", () => {
  it("depth 0, 1, 2 dispatch; 3 and 4 are limited", () => {
    assert.equal(MAX_JOURNEY_CAUSATION_DEPTH, 3);
    assert.equal(isCausationDepthLimited(0), false);
    assert.equal(isCausationDepthLimited(1), false);
    assert.equal(isCausationDepthLimited(2), false);
    assert.equal(isCausationDepthLimited(3), true);
    assert.equal(isCausationDepthLimited(4), true);
  });

  it("a malformed depth is limited (fails closed)", () => {
    for (const bad of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) assert.equal(isCausationDepthLimited(bad), true, String(bad));
  });

  it("lineage keys never change a run's depth", () => {
    const base = { triggerEvent: "lead.status_changed", triggerPayload: { causation_depth: 2 } };
    const withLineage = { ...base, triggerPayload: { causation_depth: 2, root_run_id: randomUUID(), origin_journey_id: randomUUID(), origin_run_id: randomUUID() } };
    const corrupt = { ...base, triggerPayload: { causation_depth: 2, root_run_id: "x", origin_journey_id: 0, origin_run_id: { a: 1 } } };
    assert.equal(runCausationDepth(withLineage), runCausationDepth(base));
    assert.equal(runCausationDepth(corrupt), runCausationDepth(base));
    assert.equal(runCausationDepth({ triggerEvent: "lead.status_changed", triggerPayload: { root_run_id: randomUUID() } }), 1);
  });

  it("forged or corrupt lineage on a depth-2 origin run can't get past the guard", async () => {
    const listener = journey("Listener", [], [task]);
    for (const lineage of [
      { root_run_id: randomUUID(), origin_journey_id: randomUUID() },
      { root_run_id: "garbage", origin_journey_id: listener },
      { root_run_id: null, origin_journey_id: null, origin_run_id: null },
    ]) {
      const origin = await storedRun(tenant, "lead.status_changed", { causation_depth: 2, ...lineage });
      assert.equal(await listenerRunAfterChangeBy(origin, listener), undefined, JSON.stringify(lineage));
    }
    assert.equal(logs.length, 3);
    assert.ok(logs.every((message) => /causation depth 3 reached the limit of 3/.test(message)));
  });

  it("forged origin_journey_id on the origin run doesn't change exclusion: the stored run's journey is excluded", async () => {
    const listener = journey("Listener", [], [task]);
    const originJourney = journey("Origin", [], [task]);
    const origin = await storedRun(tenant, "lead.status_changed", { causation_depth: 0, origin_journey_id: listener }, originJourney);

    const run = await listenerRunAfterChangeBy(origin, listener);

    assert.ok(run, "Listener isn't excluded by a forged payload key");
    assert.ok(!runs().some((entry) => entry.journeyId === originJourney), "the stored run's journey is excluded");
    assert.equal(delivered.at(-1)!.excludeJourneyId, originJourney);
  });
});
