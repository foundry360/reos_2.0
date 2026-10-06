import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";
import type { JourneyAIExecutor } from "./ai.ts";
import {
  CONDITION_FIELDS,
  LEAD_REPLIED_FIELD,
  operatorsForField,
  validateNodeConfig,
  type ConditionOperator,
  type ConditionValue,
} from "./contracts.ts";
import {
  dispatchJourneyEvent,
  resumeDueRuns,
  type ActionExecutor,
  type EngineDeps,
  type JourneyEvent,
} from "./engine.ts";
import { activationIssues, type JourneySnapshot, type SnapshotNode } from "./graph.ts";
import { MemoryJourneyStore } from "./memory-store.ts";

const TENANT = "tenant-a";
const OTHER_TENANT = "tenant-b";
const LEAD = "contact-1";
const OTHER_LEAD = "contact-2";
const START = "2026-10-01T12:00:00.000Z";

function node(id: string, type: SnapshotNode["type"], name: string, config: Record<string, unknown>): SnapshotNode {
  return { id, type, name, description: "", config };
}

function link(source: string, target: string, sourceHandle: string | null = null) {
  return { id: `${source}->${target}`, sourceNodeId: source, targetNodeId: target, sourceHandle, targetHandle: null };
}

function replied(operator: ConditionOperator = "equals", value: ConditionValue = true) {
  return { field: LEAD_REPLIED_FIELD, operator, value };
}

/** Trigger → Condition (replied?) → Yes action / No action */
function replyJourney(rule = replied()): JourneySnapshot {
  return {
    nodes: [
      node("t", "trigger", "New lead", { event: "lead.created", filters: [] }),
      node("c", "condition", "Replied?", rule),
      node("yes", "action", "Replied task", { action: "create_task", title: "Replied", notes: "", dueInDays: 1 }),
      node("no", "action", "Nudge", { action: "send_sms", body: "Still interested?" }),
    ],
    connections: [link("t", "c"), link("c", "yes", "yes"), link("c", "no", "no")],
  };
}

/** Trigger → SMS → Wait 1 day → Condition (replied?) → Yes / No */
function waitThenCheckJourney(): JourneySnapshot {
  return {
    nodes: [
      node("t", "trigger", "New lead", { event: "lead.created", filters: [] }),
      node("s", "action", "Intro text", { action: "send_sms", body: "Hi {{first_name}}" }),
      node("w", "action", "Wait", { action: "wait", duration: 1, unit: "days" }),
      node("c", "condition", "Replied?", replied()),
      node("yes", "action", "Replied task", { action: "create_task", title: "Replied", notes: "", dueInDays: 1 }),
      node("no", "action", "Nudge", { action: "send_sms", body: "Still interested?" }),
    ],
    connections: [link("t", "s"), link("s", "w"), link("w", "c"), link("c", "yes", "yes"), link("c", "no", "no")],
  };
}

class RecordingActions implements ActionExecutor {
  names: string[] = [];
  async execute(action: Parameters<ActionExecutor["execute"]>[0]) {
    this.names.push(action.action);
    return { status: "completed" as const, output: { ok: true } };
  }
}

const noAI: JourneyAIExecutor = {
  async execute() {
    throw new Error("AI should not run");
  },
};

function leadEvent(): JourneyEvent {
  return { tenantId: TENANT, type: "lead.created", sourceId: LEAD, contactId: LEAD, entityType: "contact", entityId: LEAD, payload: {} };
}

let store: MemoryJourneyStore;
let actions: RecordingActions;
let clock: Date;
let deps: EngineDeps;

beforeEach(() => {
  store = new MemoryJourneyStore();
  actions = new RecordingActions();
  clock = new Date(START);
  store.clock = () => new Date(clock);
  deps = { store, actions, ai: noAI, now: () => new Date(clock) };
  store.contacts.set(LEAD, { tenantId: TENANT, lead: { first_name: "Ana" } });
  store.contacts.set(OTHER_LEAD, { tenantId: TENANT, lead: { first_name: "Ben" } });
});

function message(createdAt: string, direction: "inbound" | "outbound" = "inbound", contactId = LEAD, tenantId = TENANT) {
  store.messages.push({ tenantId, contactId, direction, createdAt });
}

/** Runs the reply journey for LEAD and returns the condition's branch. */
async function branch(rule = replied()) {
  store.saveJourney(TENANT, "j1", replyJourney(rule));
  const [outcome] = await dispatchJourneyEvent(deps, leadEvent());
  assert.equal(outcome.execution?.status, "completed");
  return store.stepsFor(outcome.runId!).find((step) => step.nodeId === "c")?.output?.branch;
}

describe("condition field contract", () => {
  it("is a boolean condition field with the existing boolean operators", () => {
    const definition = CONDITION_FIELDS[LEAD_REPLIED_FIELD];
    assert.equal(definition.type, "boolean");
    assert.equal(definition.label, "Lead has replied since journey started");
    assert.equal(definition.conditionOnly, true);
    assert.deepEqual(operatorsForField(LEAD_REPLIED_FIELD), operatorsForField("lead.opted_out"));
  });

  it("validates in a Condition step", () => {
    assert.deepEqual(validateNodeConfig("condition", replied(), "strict").errors, []);
  });

  it("is rejected as a trigger filter", () => {
    const { errors } = validateNodeConfig("trigger", { event: "lead.created", filters: [replied()] }, "strict");
    assert.equal(errors.length, 1);
    assert.match(errors[0], /Filter 1: "Lead has replied since journey started" can only be used in a Condition step/);
  });

  it("blocks activation when used as a trigger filter", () => {
    const snapshot = replyJourney();
    snapshot.nodes[0].config = { event: "lead.created", filters: [replied()] };
    assert.ok(activationIssues(snapshot).some((issue) => issue.message.includes("can only be used in a Condition step")));
  });
});

describe("basic timing", () => {
  it("is false with no messages", async () => {
    assert.equal(await branch(), "no");
  });

  it("is true for an inbound message after the journey started", async () => {
    message("2026-10-01T12:00:01.000Z");
    assert.equal(await branch(), "yes");
  });

  it("is true for an inbound message exactly at the start time", async () => {
    message(START);
    assert.equal(await branch(), "yes");
  });

  it("is false for an inbound message before the journey started", async () => {
    message("2026-10-01T11:59:59.999Z");
    assert.equal(await branch(), "no");
  });

  it("compares instants, not strings, across timezone offsets", async () => {
    message("2026-10-01T08:00:00.000-04:00");
    assert.equal(await branch(), "yes");
  });
});

describe("direction", () => {
  it("ignores outbound messages", async () => {
    message("2026-10-01T12:05:00.000Z", "outbound");
    assert.equal(await branch(), "no");
  });

  it("is true for outbound followed by an inbound reply", async () => {
    message("2026-10-01T12:05:00.000Z", "outbound");
    message("2026-10-01T12:10:00.000Z", "inbound");
    assert.equal(await branch(), "yes");
  });
});

describe("multiple messages", () => {
  it("stays false with several outbound messages", async () => {
    message("2026-10-01T12:01:00.000Z", "outbound");
    message("2026-10-01T13:00:00.000Z", "outbound");
    message("2026-10-02T09:00:00.000Z", "outbound");
    assert.equal(await branch(), "no");
  });

  it("is true with several inbound messages", async () => {
    message("2026-10-01T12:01:00.000Z");
    message("2026-10-01T12:02:00.000Z");
    assert.equal(await branch(), "yes");
  });

  it("only counts the inbound message after the start in a mixed history", async () => {
    message("2026-09-30T10:00:00.000Z", "inbound");
    message("2026-10-01T11:00:00.000Z", "outbound");
    message("2026-10-01T12:30:00.000Z", "outbound");
    assert.equal(await branch(), "no");
    message("2026-10-01T12:45:00.000Z", "inbound");
    store.runs.clear();
    assert.equal(await branch(), "yes");
  });
});

describe("reply during a wait", () => {
  it("sees a reply that arrived while the run was waiting", async () => {
    store.saveJourney(TENANT, "j1", waitThenCheckJourney());
    const [outcome] = await dispatchJourneyEvent(deps, leadEvent());
    assert.equal(outcome.execution?.status, "waiting");
    assert.equal(store.runs.get(outcome.runId!)!.startedAt, START);
    assert.deepEqual(actions.names, ["send_sms"]);

    clock = new Date("2026-10-01T15:00:00.000Z");
    message(clock.toISOString(), "inbound");

    clock = new Date("2026-10-02T12:00:00.000Z");
    assert.equal((await resumeDueRuns(deps)).processed, 1);

    const run = store.runs.get(outcome.runId!)!;
    assert.equal(run.status, "completed");
    assert.equal(store.stepsFor(run.id).find((step) => step.nodeId === "c")?.output?.branch, "yes");
    assert.deepEqual(actions.names, ["send_sms", "create_task"]);
  });

  it("takes No after the wait when nothing came back", async () => {
    store.saveJourney(TENANT, "j1", waitThenCheckJourney());
    const [outcome] = await dispatchJourneyEvent(deps, leadEvent());
    message("2026-10-01T11:00:00.000Z", "inbound");
    clock = new Date("2026-10-02T12:00:00.000Z");
    await resumeDueRuns(deps);
    assert.equal(store.stepsFor(outcome.runId!).find((step) => step.nodeId === "c")?.output?.branch, "no");
    assert.deepEqual(actions.names, ["send_sms", "send_sms"]);
  });
});

describe("isolation", () => {
  it("ignores a reply recorded in another workspace", async () => {
    message("2026-10-01T12:10:00.000Z", "inbound", LEAD, OTHER_TENANT);
    assert.equal(await branch(), "no");
  });

  it("ignores a reply from another contact", async () => {
    message("2026-10-01T12:10:00.000Z", "inbound", OTHER_LEAD);
    assert.equal(await branch(), "no");
  });
});

describe("operators", () => {
  it("equals No is true when there is no reply", async () => {
    assert.equal(await branch(replied("equals", false)), "yes");
  });

  it("equals No is false after a reply", async () => {
    message("2026-10-01T12:10:00.000Z");
    assert.equal(await branch(replied("equals", false)), "no");
  });

  it("does not equal Yes is true when there is no reply", async () => {
    assert.equal(await branch(replied("not_equals", true)), "yes");
  });

  it("does not equal Yes is false after a reply", async () => {
    message("2026-10-01T12:10:00.000Z");
    assert.equal(await branch(replied("not_equals", true)), "no");
  });

  it("is never empty for a known lead", async () => {
    assert.equal(await branch(replied("is_not_empty", null)), "yes");
    store.runs.clear();
    assert.equal(await branch(replied("is_empty", null)), "no");
  });
});

describe("store query", () => {
  it("is scoped to tenant, contact, inbound direction, and start time", async () => {
    message("2026-10-01T12:00:00.000Z", "outbound");
    message("2026-10-01T12:00:00.000Z", "inbound", OTHER_LEAD);
    message("2026-10-01T12:00:00.000Z", "inbound", LEAD, OTHER_TENANT);
    message("2026-10-01T11:59:59.000Z", "inbound");
    assert.equal(await store.hasInboundMessageSince(TENANT, LEAD, START), false);
    message(START, "inbound");
    assert.equal(await store.hasInboundMessageSince(TENANT, LEAD, START), true);
  });
});
