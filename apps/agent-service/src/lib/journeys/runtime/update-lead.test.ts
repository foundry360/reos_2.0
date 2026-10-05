import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { beforeEach, describe, it } from "node:test";
import type { JourneyAIExecutor } from "./ai.ts";
import type { ActionConfig } from "./contracts.ts";
import {
  dispatchJourneyEvent,
  JourneyStepError,
  resumeDueRuns,
  type ActionExecutor,
  type ActionInput,
  type EngineDeps,
} from "./engine.ts";
import type { JourneySnapshot } from "./graph.ts";
import { MemoryJourneyStore } from "./memory-store.ts";
import { executeUpdateLead, type LeadFieldPatch, type LeadUpdateStore, type LeadWriteResult } from "./update-lead.ts";

const TENANT = "tenant-a";
const LEAD = "contact-1";

type Row = Record<string, unknown>;

/** In-memory contacts table that records every write the action makes. */
class FakeLeadStore implements LeadUpdateStore {
  rows = new Map<string, { tenantId: string; row: Row }>();
  writes: Array<{ op: string; patch?: Row }> = [];
  activity: string[] = [];
  failNext: string[] = [];

  private write(tenantId: string, contactId: string, apply: (row: Row) => boolean): LeadWriteResult {
    const failure = this.failNext.shift();
    if (failure) return { error: failure, matched: false };
    const entry = this.rows.get(contactId);
    if (!entry || entry.tenantId !== tenantId) return { error: null, matched: false };
    return { error: null, matched: apply(entry.row) };
  }

  async updateFields(tenantId: string, contactId: string, patch: LeadFieldPatch) {
    this.writes.push({ op: "updateFields", patch: { ...patch } });
    return this.write(tenantId, contactId, (row) => {
      Object.assign(row, patch);
      return true;
    });
  }

  async convertLeadToClient(tenantId: string, contactId: string, contactType: string) {
    this.writes.push({ op: "convertLeadToClient" });
    return this.write(tenantId, contactId, (row) => {
      if (row.record_type !== "lead") return false;
      row.record_type = "contact";
      row.contact_type = contactType;
      return true;
    });
  }

  async logActivity(_tenantId: string, _contactId: string, body: string) {
    this.activity.push(body);
  }
}

function startingLead(): Row {
  return {
    record_type: "lead",
    contact_type: null,
    lead_status: "Contacted",
    lead_temperature: "Warm",
    intent: null,
    qualification_score: 40,
    ready_to_book: false,
    handoff: false,
    recommended_next_action: "Follow up",
    ai_summary: "Original summary",
    email: "ana@example.com",
  };
}

function update(fields: Record<string, unknown>): Extract<ActionConfig, { action: "update_lead" }> {
  return { action: "update_lead", fields: fields as LeadFieldPatch };
}

function inputFor(row: Row, contactId: string | null = LEAD): ActionInput {
  return { tenantId: TENANT, runId: "run-1", nodeId: "u", contactId, lead: row, opportunity: null };
}

let leads: FakeLeadStore;
let row: Row;

beforeEach(() => {
  leads = new FakeLeadStore();
  row = startingLead();
  leads.rows.set(LEAD, { tenantId: TENANT, row });
});

/** Columns whose value differs from the starting lead. */
function changed(): Row {
  const before = startingLead();
  return Object.fromEntries(Object.entries(row).filter(([key, value]) => before[key] !== value));
}

describe("Journey Update lead writes only configured fields", () => {
  it("A: intent alone leaves status unchanged", async () => {
    const result = await executeUpdateLead(update({ intent: "Buyer" }), inputFor(row), leads);

    assert.equal(result.status, "completed");
    assert.deepEqual(changed(), { intent: "Buyer" });
    assert.equal(row.lead_status, "Contacted");
    assert.deepEqual(leads.writes, [{ op: "updateFields", patch: { intent: "Buyer" } }]);
  });

  it("B: ready to book alone leaves status unchanged", async () => {
    await executeUpdateLead(update({ ready_to_book: true }), inputFor(row), leads);

    assert.deepEqual(changed(), { ready_to_book: true });
    assert.equal(row.lead_status, "Contacted");
  });

  it("C: several explicit fields change and nothing else does", async () => {
    const result = await executeUpdateLead(
      update({ lead_temperature: "Hot", qualification_score: 85, handoff: true, recommended_next_action: "Call today" }),
      inputFor(row),
      leads,
    );

    assert.deepEqual(changed(), {
      lead_temperature: "Hot",
      qualification_score: 85,
      handoff: true,
      recommended_next_action: "Call today",
    });
    assert.equal(row.ai_summary, "Original summary");
    assert.deepEqual(result.output, {
      updated: ["lead_temperature", "qualification_score", "handoff", "recommended_next_action"],
      converted: false,
    });
    assert.deepEqual(leads.activity, [
      "Journey set temperature, qualification score, hand off to a person, recommended next action.",
    ]);
  });

  it("D: empty, blank, and unknown fields are never written", async () => {
    await executeUpdateLead(
      update({ intent: "Seller", recommended_next_action: "   ", lead_status: null, email: "x@y.com", record_type: "contact" }),
      inputFor(row),
      leads,
    );
    assert.deepEqual(leads.writes, [{ op: "updateFields", patch: { intent: "Seller" } }]);
    assert.deepEqual(changed(), { intent: "Seller" });

    leads.writes = [];
    const result = await executeUpdateLead(update({ recommended_next_action: "" }), inputFor(row), leads);
    assert.equal(result.status, "skipped");
    assert.deepEqual(leads.writes, [], "nothing is written when no field is set");
    assert.equal(leads.activity.length, 1);
  });

  it("D: false is a real value, not an empty one", async () => {
    row.handoff = true;
    await executeUpdateLead(update({ handoff: false }), inputFor(row), leads);
    assert.equal(row.handoff, false);
  });

  it("E: an explicit status is applied as chosen", async () => {
    await executeUpdateLead(update({ lead_status: "Qualified" }), inputFor(row), leads);

    assert.deepEqual(changed(), { lead_status: "Qualified" });
    assert.equal(row.record_type, "lead");
    assert.ok(!leads.writes.some((w) => w.op === "convertLeadToClient"));
  });
});

describe("Converted", () => {
  it("F: an explicit Converted status turns the lead into a client", async () => {
    const result = await executeUpdateLead(update({ lead_status: "Converted" }), inputFor(row), leads);

    assert.equal(row.lead_status, "Converted");
    assert.equal(row.record_type, "contact");
    assert.equal(row.contact_type, "Prospect");
    assert.equal(row.ready_to_book, false, "ready to book is left as it was");
    assert.deepEqual(result.output, { updated: ["lead_status"], converted: true });
    assert.deepEqual(leads.activity, ["Journey set lead status. Converted to client."]);
  });

  it("F: other fields never convert the lead", async () => {
    await executeUpdateLead(
      update({ intent: "Buyer", ready_to_book: true, lead_temperature: "Hot", qualification_score: 100, handoff: true }),
      inputFor(row),
      leads,
    );

    assert.equal(row.record_type, "lead");
    assert.equal(row.lead_status, "Contacted");
    assert.ok(!leads.writes.some((w) => w.op === "convertLeadToClient"));
  });

  it("F: an existing client keeps its client type", async () => {
    row.record_type = "contact";
    row.contact_type = "Customer";
    const result = await executeUpdateLead(update({ lead_status: "Converted" }), inputFor(row), leads);

    assert.equal(row.contact_type, "Customer");
    assert.equal(result.output.converted, false);
  });
});

describe("no hidden agent behaviour", () => {
  it("G: the action only performs the configured write and the activity log", async () => {
    await executeUpdateLead(update({ intent: "Investor", ready_to_book: true }), inputFor(row), leads);
    assert.deepEqual(leads.writes.map((w) => w.op), ["updateFields"]);
    assert.equal(row.ai_summary, "Original summary");
    assert.equal(row.qualification_score, 40);
  });

  it("G: the live executor no longer goes through the lead agent's tool path", () => {
    const source = readFileSync(new URL("./live-actions.ts", import.meta.url), "utf8");
    for (const banned of [
      "apply-tools",
      "applyToolCalls",
      "ensureAiSummary",
      "ensureScoreAndTemperature",
      "syncIntakeOpportunityStage",
      "updateContactFields",
    ]) {
      assert.ok(!source.includes(banned), `live-actions.ts must not reference ${banned}`);
    }
  });
});

describe("errors", () => {
  it("H: a failed write is a transient step error", async () => {
    leads.failNext.push("connection reset");
    await assert.rejects(
      executeUpdateLead(update({ intent: "Buyer" }), inputFor(row), leads),
      (error: unknown) => error instanceof JourneyStepError && error.kind === "transient" && error.message === "connection reset",
    );
    assert.equal(leads.activity.length, 0);
  });

  it("H: a failed conversion is a transient step error", async () => {
    leads.failNext.push("", "timeout");
    await assert.rejects(
      executeUpdateLead(update({ lead_status: "Converted" }), inputFor(row), leads),
      (error: unknown) => error instanceof JourneyStepError && error.kind === "transient",
    );
  });

  it("H: a lead missing from the workspace is a configuration error", async () => {
    leads.rows.set(LEAD, { tenantId: "tenant-b", row });
    await assert.rejects(
      executeUpdateLead(update({ intent: "Buyer" }), inputFor(row), leads),
      (error: unknown) => error instanceof JourneyStepError && error.kind === "config",
    );
    assert.equal(row.intent, null, "another workspace's lead is untouched");
  });

  it("H: a run without a lead is a configuration error", async () => {
    await assert.rejects(
      executeUpdateLead(update({ intent: "Buyer" }), inputFor(row, null), leads),
      (error: unknown) => error instanceof JourneyStepError && error.kind === "config",
    );
  });

  it("H: write failures use the engine's existing retry and backoff", async () => {
    const store = new MemoryJourneyStore();
    store.contacts.set(LEAD, { tenantId: TENANT, lead: row });
    const journey: JourneySnapshot = {
      nodes: [
        { id: "t", type: "trigger", name: "New lead", description: "", config: { event: "lead.created", filters: [] } },
        { id: "u", type: "action", name: "Update", description: "", config: { action: "update_lead", fields: { intent: "Buyer" } } },
      ],
      connections: [{ id: "t->u", sourceNodeId: "t", targetNodeId: "u", sourceHandle: null, targetHandle: null }],
    };
    store.saveJourney(TENANT, "j1", journey);
    const actions: ActionExecutor = {
      async execute(action, input) {
        assert.equal(action.action, "update_lead");
        return executeUpdateLead(action as Extract<ActionConfig, { action: "update_lead" }>, input, leads);
      },
    };
    const ai: JourneyAIExecutor = {
      async execute() {
        throw new Error("unused");
      },
    };
    let clock = new Date("2026-10-01T12:00:00Z");
    const deps: EngineDeps = { store, actions, ai, now: () => new Date(clock) };

    leads.failNext.push("connection reset");
    const [outcome] = await dispatchJourneyEvent(deps, {
      tenantId: TENANT,
      type: "lead.created",
      sourceId: LEAD,
      contactId: LEAD,
      entityType: "contact",
      entityId: LEAD,
      payload: {},
    });
    const runId = outcome.runId!;
    assert.equal(outcome.execution?.status, "waiting");
    const failed = store.stepsFor(runId).find((s) => s.nodeId === "u")!;
    assert.equal(failed.errorKind, "transient");
    assert.equal(store.runs.get(runId)!.resumeAt, "2026-10-01T12:01:00.000Z");

    clock = new Date(clock.getTime() + 60_000);
    await resumeDueRuns(deps);
    assert.equal(store.runs.get(runId)!.status, "completed");
    assert.equal(row.intent, "Buyer");
    assert.equal(row.lead_status, "Contacted");
  });
});
