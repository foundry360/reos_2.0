/**
 * Journey-caused lifecycle events (migration 061) through the real Journey
 * action executor: Assign lead and Update lead (handoff) run unmodified, write
 * through supabase-js, and the triggers record lead.assigned /
 * lead.handoff_requested with the run's lineage. The real journey event
 * dispatcher then delivers them. live-actions-test-env.ts must be the first
 * import; it fails closed on any other network access.
 */

import { attachTestDb, blockedRequests, LIVE_ACTIONS_SCHEMA, providers } from "./live-actions-test-env.ts";

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { after, afterEach, beforeEach, describe, it } from "node:test";
import type { JourneyAIExecutor } from "./ai.ts";
import type { ActionConfig } from "./contracts.ts";
import { dispatchJourneyEvent, type ActionInput, type EngineDeps } from "./engine.ts";
import type { JourneySnapshot } from "./graph.ts";
import { createSupabaseJourneyEventOutbox, dispatchJourneyEvents } from "./journey-event-outbox.ts";
import { DEFAULT_OUTBOX_OPTIONS } from "./lead-status-outbox.ts";
import { createTestDb } from "./lead-status-test-db.ts";
import { MemoryJourneyStore } from "./memory-store.ts";

const migration = (name: string) => readFileSync(new URL(`../../../../../../supabase/migrations/${name}`, import.meta.url), "utf8");

/** The columns migrations 060 and 061 need beyond the live-actions schema. */
const LIFECYCLE_COLUMNS = `
alter table public.contacts add column handoff boolean not null default false;
alter table public.contact_activities
  add column ends_at timestamptz,
  add column source text,
  add column metadata jsonb;
alter table public.opportunities
  add column pipeline text not null default 'Intake',
  add column stage text not null default 'New';
`;

const db = await createTestDb({
  schema: [LIVE_ACTIONS_SCHEMA, LIFECYCLE_COLUMNS, migration("060_journey_events.sql"), migration("061_journey_lifecycle_events.sql")].join("\n"),
});
attachTestDb(db);
const { createLiveActionExecutor } = await import("./live-actions.ts");

const service = db.client("service_role");
const executor = createLiveActionExecutor(service);
const AGENT = randomUUID();

let tenant: string;

after(async () => {
  await db.pg.close();
});

beforeEach(async () => {
  await db.reset();
  providers.reset();
  [{ id: tenant }] = await db.query<{ id: string }>("insert into public.tenants default values returning id");
  await db.query("insert into public.memberships (tenant_id, user_id) values ($1, $2)", [tenant, AGENT]);
});

afterEach(() => {
  assert.deepEqual(blockedRequests, [], "no request may leave the test environment");
});

async function newLead(): Promise<string> {
  const [row] = await db.query<{ id: string }>("insert into public.contacts (tenant_id, first_name) values ($1, 'Ana') returning id", [tenant]);
  return row.id;
}

/** A run of `journeyId` as journey_runs stores it; its id is what the action writes as origin. */
async function run(journeyId: string): Promise<string> {
  const [row] = await db.query<{ id: string }>(
    "insert into public.journey_runs (tenant_id, journey_id, trigger_event) values ($1, $2, 'manual') returning id",
    [tenant, journeyId],
  );
  return row.id;
}

async function execute(action: Exclude<ActionConfig, { action: "wait" }>, contactId: string, runId: string) {
  const [lead] = await db.query<Record<string, unknown>>("select * from public.contacts where id = $1", [contactId]);
  const input: ActionInput = { tenantId: tenant, runId, nodeId: "node", contactId, lead, opportunity: null };
  return executor.execute(action, input);
}

function events() {
  return db.query<{ event_type: string; origin: string | null; origin_run_id: string | null; payload: Record<string, unknown> }>(
    "select event_type, origin, origin_run_id, payload from public.journey_events order by created_at, id",
  );
}

function listener(store: MemoryJourneyStore, event: string): string {
  const id = randomUUID();
  const snapshot: JourneySnapshot = {
    nodes: [
      { id: `${id}-t`, type: "trigger", name: "Trigger", description: "", config: { event, filters: [] } },
      { id: `${id}-a`, type: "action", name: "Task", description: "", config: { action: "create_task", title: "Follow up", notes: "", dueInDays: 1 } },
    ],
    connections: [{ id: `${id}-c`, sourceNodeId: `${id}-t`, targetNodeId: `${id}-a`, sourceHandle: null, targetHandle: null }],
  };
  store.saveJourney(tenant, id, snapshot);
  return id;
}

async function deliverTo(store: MemoryJourneyStore, contactId: string) {
  store.contacts.set(contactId, { tenantId: tenant, lead: { lead_status: "New" } });
  const ai: JourneyAIExecutor = { execute: async () => ({ success: true, output: {}, text: "" }) };
  const deps: EngineDeps = { store, ai, actions: { execute: async () => ({ status: "completed", output: {} }) } };
  return dispatchJourneyEvents(createSupabaseJourneyEventOutbox(service), (event) => dispatchJourneyEvent(deps, event), {
    ...DEFAULT_OUTBOX_OPTIONS,
    budgetMs: 60_000,
  });
}

describe("Assign lead", () => {
  it("records lead.assigned with origin journey and the run id; dispatch excludes the run's journey and carries its lineage", async () => {
    const store = new MemoryJourneyStore();
    const assigner = listener(store, "lead.assigned");
    const other = listener(store, "lead.assigned");
    const lead = await newLead();
    const runId = await run(assigner);

    const result = await execute({ action: "assign_lead", agentUserId: AGENT }, lead, runId);

    assert.equal(result.status, "completed");
    assert.deepEqual(await events(), [
      {
        event_type: "lead.assigned",
        origin: "journey",
        origin_run_id: runId,
        payload: { contact_id: lead, from_agent_id: null, to_agent_id: AGENT, origin: "journey" },
      },
    ]);
    assert.equal((await db.query("select id from public.lead_status_events")).length, 0, "Stage 1 unaffected");

    const summary = await deliverTo(store, lead);
    assert.equal(summary.delivered, 1);
    const started = [...store.runs.values()];
    assert.deepEqual(started.map((entry) => entry.journeyId), [other]);
    assert.equal(started[0].triggerPayload.origin_journey_id, assigner);
    assert.equal(started[0].triggerPayload.root_run_id, runId);
    assert.equal(started[0].triggerPayload.causation_depth, 1);
  });

  it("assigning the agent the lead already has records nothing", async () => {
    const lead = await newLead();
    await execute({ action: "assign_lead", agentUserId: AGENT }, lead, await run(randomUUID()));
    await execute({ action: "assign_lead", agentUserId: AGENT }, lead, await run(randomUUID()));
    assert.equal((await events()).length, 1);
  });
});

describe("Update lead: handoff", () => {
  it("handoff false → true records lead.handoff_requested with the run's lineage; setting it again records nothing", async () => {
    const lead = await newLead();
    const runId = await run(randomUUID());
    await execute({ action: "update_lead", fields: { handoff: true } }, lead, runId);
    await execute({ action: "update_lead", fields: { handoff: true } }, lead, await run(randomUUID()));
    assert.deepEqual(await events(), [
      { event_type: "lead.handoff_requested", origin: "journey", origin_run_id: runId, payload: { contact_id: lead, origin: "journey" } },
    ]);
  });
});
