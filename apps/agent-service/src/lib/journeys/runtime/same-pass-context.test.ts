import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";
import type { JourneyAIExecutor, JourneyAIRequest, JourneyAIResult } from "./ai.ts";
import type { ConditionValue } from "./contracts.ts";
import {
  dispatchJourneyEvent,
  executeRun,
  LEASE_MS,
  resumeDueRuns,
  type ActionExecutor,
  type ActionInput,
  type EngineDeps,
  type JourneyEvent,
} from "./engine.ts";
import type { JourneySnapshot, SnapshotNode } from "./graph.ts";
import { MemoryJourneyStore } from "./memory-store.ts";
import { executeUpdateLead, type LeadUpdateStore } from "./update-lead.ts";

const TENANT = "tenant-a";
const LEAD = "contact-1";
const AGENT = "11111111-1111-1111-1111-111111111111";

function node(id: string, type: SnapshotNode["type"], name: string, config: Record<string, unknown>): SnapshotNode {
  return { id, type, name, description: "", config };
}

function link(source: string, target: string, sourceHandle: string | null = null) {
  return { id: `${source}->${target}`, sourceNodeId: source, targetNodeId: target, sourceHandle, targetHandle: null };
}

const trigger = node("t", "trigger", "New lead", { event: "lead.created", filters: [] });
const updateLead = (fields: Record<string, unknown>, id = "u") => node(id, "action", "Update lead", { action: "update_lead", fields });
const condition = (field: string, value: ConditionValue, id = "c") => node(id, "condition", `Check ${field}`, { field, operator: "equals", value });
const aiStep = (id = "ai") => node(id, "ai", "Summarize", { goal: "Summarize the lead", instructions: "", agent: "default" });
const task = (id: string) => node(id, "action", id, { action: "create_task", title: id, notes: "", dueInDays: 1 });

/** Trigger → steps… → Condition → Yes / No */
function journey(steps: SnapshotNode[], check: SnapshotNode, after: { yes?: SnapshotNode[]; no?: SnapshotNode[] } = {}): JourneySnapshot {
  const yes = after.yes ?? [task("yes")];
  const no = after.no ?? [task("no")];
  const chain = [trigger, ...steps, check];
  const connections = chain.slice(1).map((entry, index) => link(chain[index].id, entry.id));
  connections.push(link(check.id, yes[0].id, "yes"), link(check.id, no[0].id, "no"));
  for (const branch of [yes, no]) branch.slice(1).forEach((entry, index) => connections.push(link(branch[index].id, entry.id)));
  return { nodes: [...chain, ...yes, ...no], connections };
}

class FakeAI implements JourneyAIExecutor {
  requests: JourneyAIRequest[] = [];
  async execute(request: JourneyAIRequest): Promise<JourneyAIResult> {
    this.requests.push(structuredClone(request));
    return { success: true, output: {}, text: "ok" };
  }
}

let store: MemoryJourneyStore;
let ai: FakeAI;
let clock: Date;
let deps: EngineDeps;
let actionNames: string[];
let loads: number;

/** The persisted lead row the memory store serves from loadEntities. */
const persisted = () => store.contacts.get(LEAD)!.lead;

beforeEach(() => {
  store = new MemoryJourneyStore();
  ai = new FakeAI();
  clock = new Date("2026-10-01T12:00:00Z");
  actionNames = [];
  loads = 0;
  store.contacts.set(LEAD, {
    tenantId: TENANT,
    lead: {
      first_name: "Ana",
      record_type: "lead",
      contact_type: null,
      lead_status: "Contacted",
      lead_temperature: "Hot",
      intent: "Buyer",
      qualification_score: 40,
      ready_to_book: true,
      handoff: false,
      assigned_agent_id: null,
      ai_summary: "Original summary",
    },
    opportunity: { id: "opp-1", stage: "New", assigned_agent_id: null },
  });

  const loadEntities = store.loadEntities.bind(store);
  store.loadEntities = async (tenantId, contactId) => {
    loads++;
    return loadEntities(tenantId, contactId);
  };

  // The real Update lead executor, writing to the persisted memory contact.
  const leadStore: LeadUpdateStore = {
    async updateFields(tenantId, contactId, patch) {
      const contact = store.contacts.get(contactId);
      if (!contact || contact.tenantId !== tenantId) return { error: null, matched: false };
      Object.assign(contact.lead, patch);
      return { error: null, matched: true };
    },
    async convertLeadToClient(tenantId, contactId, contactType) {
      const contact = store.contacts.get(contactId);
      if (!contact || contact.tenantId !== tenantId || contact.lead.record_type !== "lead") return { error: null, matched: false };
      Object.assign(contact.lead, { record_type: "contact", contact_type: contactType });
      return { error: null, matched: true };
    },
    async logActivity() {},
  };

  const actions: ActionExecutor = {
    async execute(action, input: ActionInput) {
      actionNames.push(action.action === "create_task" ? action.title : action.action);
      if (action.action === "update_lead") return executeUpdateLead(action, input, leadStore);
      if (action.action === "assign_lead") {
        const contact = store.contacts.get(input.contactId!)!;
        contact.lead.assigned_agent_id = action.agentUserId;
        if (contact.opportunity && !contact.opportunity.assigned_agent_id) contact.opportunity.assigned_agent_id = action.agentUserId;
        return { status: "completed", output: { assigned_agent_id: action.agentUserId } };
      }
      return { status: "completed", output: { ok: true } };
    },
  };
  deps = { store, actions, ai, now: () => new Date(clock) };
});

const leadEvent = (): JourneyEvent => ({ tenantId: TENANT, type: "lead.created", sourceId: LEAD, contactId: LEAD, entityType: "contact", entityId: LEAD, payload: {} });

async function run(snapshot: JourneySnapshot) {
  store.saveJourney(TENANT, "j1", snapshot);
  const [outcome] = await dispatchJourneyEvent(deps, leadEvent());
  return outcome;
}

const branch = (runId: string, nodeId = "c") => store.stepsFor(runId).find((step) => step.nodeId === nodeId)?.output?.branch;

describe("Update lead → Condition in the same pass", () => {
  it("sees the updated field (Hot → Cold takes Yes)", async () => {
    const outcome = await run(journey([updateLead({ lead_temperature: "Cold" })], condition("lead.lead_temperature", "Cold")));
    assert.equal(outcome.execution?.status, "completed");
    assert.equal(branch(outcome.runId!), "yes");
    assert.deepEqual(actionNames, ["update_lead", "yes"]);
  });

  it("an unchanged field keeps its persisted value", async () => {
    const outcome = await run(journey([updateLead({ lead_temperature: "Cold" })], condition("lead.intent", "Buyer")));
    assert.equal(branch(outcome.runId!), "yes");
    assert.equal(persisted().intent, "Buyer");
  });

  it("sees every field from a multi-field update", async () => {
    // Trigger → Update → c (intent) → c2 (score) → c3 (temperature) → c4 (status) → all-yes; any No → partial
    const checks = [
      condition("lead.intent", "Seller", "c"),
      condition("lead.qualification_score", 85, "c2"),
      condition("lead.lead_temperature", "Warm", "c3"),
      condition("lead.lead_status", "Qualified", "c4"),
    ];
    const update = updateLead({ lead_temperature: "Warm", intent: "Seller", qualification_score: 85, lead_status: "Qualified" });
    const snapshot: JourneySnapshot = {
      nodes: [trigger, update, ...checks, task("all-yes"), task("partial")],
      connections: [
        link("t", "u"),
        link("u", "c"),
        ...checks.map((check, index) => link(check.id, checks[index + 1]?.id ?? "all-yes", "yes")),
        ...checks.map((check) => link(check.id, "partial", "no")),
      ],
    };

    const outcome = await run(snapshot);
    assert.equal(outcome.execution?.status, "completed");
    assert.deepEqual(["c", "c2", "c3", "c4"].map((id) => branch(outcome.runId!, id)), ["yes", "yes", "yes", "yes"]);
    assert.deepEqual(actionNames, ["update_lead", "all-yes"]);
  });

  it("an explicit false is written and seen as false", async () => {
    const outcome = await run(journey([updateLead({ ready_to_book: false })], condition("lead.ready_to_book", false)));
    assert.equal(persisted().ready_to_book, false);
    assert.equal(branch(outcome.runId!), "yes");
  });

  it("Converted still converts, and the next step sees the converted record", async () => {
    const outcome = await run(journey([updateLead({ lead_status: "Converted" }), aiStep()], condition("lead.lead_status", "Converted")));
    assert.equal(branch(outcome.runId!), "yes");
    assert.equal(persisted().record_type, "contact");
    assert.equal(persisted().contact_type, "Prospect");
    assert.equal(ai.requests[0].context.lead?.record_type, "contact");
    assert.equal(ai.requests[0].context.lead?.lead_status, "Converted");
  });

  it("writes only the configured field; nothing else on the lead changes", async () => {
    const before = structuredClone(persisted());
    await run(journey([updateLead({ lead_temperature: "Cold" })], condition("lead.lead_temperature", "Cold")));
    assert.deepEqual(persisted(), { ...before, lead_temperature: "Cold" });
    assert.deepEqual(store.contacts.get(LEAD)!.opportunity, { id: "opp-1", stage: "New", assigned_agent_id: null });
  });
});

describe("Update lead and AI steps", () => {
  it("Update lead → AI: the AI step receives the updated lead", async () => {
    const outcome = await run(journey([updateLead({ lead_temperature: "Cold", handoff: true }), aiStep()], condition("lead.handoff", true)));
    assert.equal(outcome.execution?.status, "completed");
    assert.equal(ai.requests.length, 1);
    assert.equal(ai.requests[0].context.lead?.lead_temperature, "Cold");
    assert.equal(ai.requests[0].context.lead?.handoff, true);
  });

  it("Update lead → Condition → AI: both see the update", async () => {
    const outcome = await run(journey([updateLead({ lead_temperature: "Cold" })], condition("lead.lead_temperature", "Cold"), { yes: [aiStep()], no: [task("no")] }));
    assert.equal(branch(outcome.runId!), "yes");
    assert.equal(ai.requests[0].context.lead?.lead_temperature, "Cold");
  });

  it("Update lead → AI → Condition: both see the update", async () => {
    const outcome = await run(journey([updateLead({ intent: "Investor" }), aiStep()], condition("lead.intent", "Investor")));
    assert.equal(ai.requests[0].context.lead?.intent, "Investor");
    assert.equal(branch(outcome.runId!), "yes");
  });

  it("an AI step before Update lead still gets the value from the start of the pass", async () => {
    await run(journey([aiStep(), updateLead({ lead_temperature: "Cold" })], condition("lead.lead_temperature", "Cold")));
    assert.equal(ai.requests[0].context.lead?.lead_temperature, "Hot");
  });
});

describe("Assign lead in the same pass", () => {
  it("a later Condition and AI step see the new assigned agent and opportunity owner", async () => {
    const assign = node("a", "action", "Assign", { action: "assign_lead", agentUserId: AGENT });
    const outcome = await run(journey([assign, aiStep()], condition("lead.assigned_agent_id", AGENT)));
    assert.equal(branch(outcome.runId!), "yes");
    assert.equal(ai.requests[0].context.lead?.assigned_agent_id, AGENT);
    assert.equal(ai.requests[0].context.opportunity?.assigned_agent_id, AGENT);
  });
});

describe("when the lead data is reloaded", () => {
  it("only after a successful lead-changing action", async () => {
    await run(journey([task("t1"), updateLead({ lead_temperature: "Cold" }), task("t2")], condition("lead.lead_temperature", "Cold")));
    assert.equal(loads, 3, "dispatch's trigger-filter load, the pass load, and one reload after Update lead");
  });

  it("not after an Update lead with nothing to write", async () => {
    const outcome = await run(journey([updateLead({ intent: "  " })], condition("lead.lead_temperature", "Hot")));
    assert.equal(store.stepsFor(outcome.runId!).find((step) => step.nodeId === "u")?.status, "skipped");
    assert.equal(loads, 2, "dispatch's trigger-filter load and the pass load only");
  });

  it("a failed reload doesn't repeat Update lead; the run continues from the next step", async () => {
    const loadEntities = store.loadEntities;
    let calls = 0;
    store.loadEntities = async (tenantId, contactId) => {
      calls++;
      // 1: dispatch's trigger filters, 2: the pass load, 3: the reload after Update lead.
      if (calls === 3) throw new Error("Journey store loadEntities failed: connection reset");
      return loadEntities(tenantId, contactId);
    };
    store.saveJourney(TENANT, "j1", journey([updateLead({ lead_temperature: "Cold" })], condition("lead.lead_temperature", "Cold")));
    await assert.rejects(dispatchJourneyEvent(deps, leadEvent()), /connection reset/);

    const [runRecord] = [...store.runs.values()];
    assert.equal(runRecord.currentNodeId, "c", "advanced past Update lead before the reload");
    assert.equal(store.stepsFor(runRecord.id).find((step) => step.nodeId === "u")?.status, "completed");

    clock = new Date(clock.getTime() + LEASE_MS + 1);
    runRecord.resumeAt = clock.toISOString();
    assert.equal((await executeRun(deps, runRecord.id)).status, "completed");
    assert.deepEqual(actionNames, ["update_lead", "yes"], "Update lead ran exactly once");
    assert.equal(branch(runRecord.id), "yes");
  });
});

describe("Update lead → Wait → Condition", () => {
  it("still sees the update after resuming", async () => {
    const wait = node("w", "action", "Wait", { action: "wait", duration: 1, unit: "hours" });
    const outcome = await run(journey([updateLead({ lead_temperature: "Cold" }), wait], condition("lead.lead_temperature", "Cold")));
    assert.equal(outcome.execution?.status, "waiting");
    clock = new Date("2026-10-01T13:00:00Z");
    await resumeDueRuns(deps);
    assert.equal(branch(outcome.runId!), "yes");
  });

  it("reads fresh persisted data after resuming, including changes made outside the journey", async () => {
    const wait = node("w", "action", "Wait", { action: "wait", duration: 1, unit: "hours" });
    const outcome = await run(journey([updateLead({ lead_temperature: "Cold" }), wait], condition("lead.lead_temperature", "Warm")));
    persisted().lead_temperature = "Warm";
    clock = new Date("2026-10-01T13:00:00Z");
    await resumeDueRuns(deps);
    assert.equal(branch(outcome.runId!), "yes");
  });
});
