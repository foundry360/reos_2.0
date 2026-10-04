import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { evaluateCondition, type ExecutionContext } from "./conditions.ts";
import { renderTemplate, validateNodeConfig } from "./contracts.ts";
import { activationIssues, nextNodeId, type JourneySnapshot } from "./graph.ts";

const context: ExecutionContext = {
  lead: { lead_status: "Qualified", qualification_score: 72, email: "", ready_to_book: true, budget: "$500k" },
  opportunity: { stage: "Qualified" },
  trigger: { event: "message.received", payload: { channel: "sms", body: "Is it still available?" } },
  steps: { ask: { output: { answer: "Yes" } } },
};

describe("conditions", () => {
  const cases: Array<[string, string, unknown, boolean]> = [
    ["lead.lead_status", "equals", "qualified", true],
    ["lead.lead_status", "not_equals", "New", true],
    ["lead.qualification_score", "greater_than", 70, true],
    ["lead.qualification_score", "less_than_or_equal", 71, false],
    ["lead.qualification_score", "greater_than", "abc", false],
    ["lead.email", "is_empty", null, true],
    ["lead.timeline", "is_empty", null, true],
    ["lead.budget", "contains", "500", true],
    ["lead.ready_to_book", "equals", true, true],
    ["lead.ready_to_book", "equals", "false", false],
    ["opportunity.stage", "equals", "Qualified", true],
    ["trigger.body", "contains", "AVAILABLE", true],
    ["steps.ask.output.answer", "equals", "yes", true],
    ["steps.missing.output.answer", "is_not_empty", null, false],
  ];
  for (const [field, operator, value, expected] of cases) {
    it(`${field} ${operator} ${String(value)} → ${expected}`, () => {
      assert.equal(evaluateCondition({ field, operator: operator as never, value: value as never }, context), expected);
    });
  }

  it("treats a missing lead as empty instead of throwing", () => {
    assert.equal(
      evaluateCondition({ field: "lead.lead_status", operator: "is_empty", value: null }, { ...context, lead: null }),
      true,
    );
  });
});

describe("node config validation", () => {
  it("drops unknown keys and arbitrary fields", () => {
    const { config, errors } = validateNodeConfig(
      "condition",
      { field: "lead.__proto__", operator: "eval", value: "1", sql: "drop table" },
      "strict",
    );
    assert.equal("sql" in config, false);
    assert.ok(errors.length >= 2);
  });

  it("rejects operators that don't fit the field type", () => {
    const { errors } = validateNodeConfig(
      "condition",
      { field: "lead.ready_to_book", operator: "greater_than", value: 1 },
      "strict",
    );
    assert.match(errors.join(" "), /doesn't apply/);
  });

  it("requires implemented trigger events", () => {
    assert.equal(validateNodeConfig("trigger", { event: "lead.created" }, "strict").errors.length, 0);
    assert.match(validateNodeConfig("trigger", { event: "manual" }, "strict").errors[0], /isn't available/);
    assert.match(validateNodeConfig("trigger", {}, "strict").errors[0], /Choose the event/);
  });

  it("validates actions", () => {
    assert.deepEqual(validateNodeConfig("action", { action: "send_sms", body: "" }, "strict").errors, [
      "Write the SMS message.",
    ]);
    assert.equal(validateNodeConfig("action", { action: "send_sms", body: "" }, "draft").errors.length, 0);
    const wait = validateNodeConfig("action", { action: "wait", duration: "3", unit: "hours" }, "strict");
    assert.deepEqual(wait.config, { action: "wait", duration: 3, unit: "hours" });
    assert.ok(validateNodeConfig("action", { action: "wait", duration: 0, unit: "days" }, "strict").errors.length);
    const update = validateNodeConfig(
      "action",
      { action: "update_lead", fields: { lead_status: "Bogus", qualification_score: "250", handoff: true, id: "x" } },
      "strict",
    );
    assert.deepEqual(update.config, { action: "update_lead", fields: { qualification_score: 100, handoff: true } });
    assert.ok(validateNodeConfig("action", { action: "run_shell" }, "strict").errors.length);
  });

  it("never stores a model name on AI nodes", () => {
    const { config } = validateNodeConfig("ai", { goal: "Qualify", model: "gpt-4o", agent: "Bad Key!" }, "strict");
    assert.deepEqual(config, { goal: "Qualify", instructions: "", agent: "default" });
  });
});

describe("templates", () => {
  it("fills known placeholders and leaves others alone", () => {
    assert.equal(
      renderTemplate("Hi {{ first_name }}, {{unknown}} {{full_name}}", { first_name: "Ana", last_name: "Diaz" }),
      "Hi Ana, {{unknown}} Ana Diaz",
    );
    assert.equal(renderTemplate("Hi {{first_name}}", {}), "Hi there");
  });
});

function graph(): JourneySnapshot {
  const n = (id: string, type: "trigger" | "action" | "condition", config: Record<string, unknown>) => ({
    id,
    type,
    name: id,
    description: "",
    config,
  });
  return {
    nodes: [
      n("t", "trigger", { event: "lead.created", filters: [] }),
      n("c", "condition", { field: "lead.lead_status", operator: "equals", value: "New" }),
      n("a", "action", { action: "send_sms", body: "Hi" }),
      n("b", "action", { action: "create_task", title: "Call", notes: "", dueInDays: 1 }),
    ],
    connections: [
      { id: "1", sourceNodeId: "t", targetNodeId: "c", sourceHandle: null, targetHandle: null },
      { id: "2", sourceNodeId: "c", targetNodeId: "a", sourceHandle: "yes", targetHandle: null },
      { id: "3", sourceNodeId: "c", targetNodeId: "b", sourceHandle: "no", targetHandle: null },
    ],
  };
}

describe("graph", () => {
  it("follows the yes/no handles; a legacy null handle counts as Yes", () => {
    const g = graph();
    assert.equal(nextNodeId(g, "c", true), "a");
    assert.equal(nextNodeId(g, "c", false), "b");
    g.connections[1].sourceHandle = null;
    assert.equal(nextNodeId(g, "c", true), "a");
    assert.equal(nextNodeId(g, "t"), "c");
    assert.equal(nextNodeId(g, "a"), null);
  });

  it("accepts a valid journey", () => {
    assert.deepEqual(activationIssues(graph()), []);
  });

  it("requires a trigger", () => {
    const g = graph();
    g.nodes = g.nodes.filter((node) => node.type !== "trigger");
    assert.match(activationIssues(g)[0].message, /Add a Trigger/);
  });

  it("flags orphan nodes", () => {
    const g = graph();
    g.nodes.push({ id: "orphan", type: "action", name: "Lonely", description: "", config: { action: "send_sms", body: "x" } });
    assert.match(activationIssues(g).map((i) => i.message).join(), /"Lonely" isn't reachable/);
  });

  it("flags cycles", () => {
    const g = graph();
    g.connections.push({ id: "4", sourceNodeId: "a", targetNodeId: "c", sourceHandle: null, targetHandle: null });
    assert.match(activationIssues(g).map((i) => i.message).join(), /loops back/);
  });

  it("flags non-condition branching and missing configs", () => {
    const g = graph();
    g.connections.push({ id: "5", sourceNodeId: "a", targetNodeId: "b", sourceHandle: null, targetHandle: null });
    g.connections.push({ id: "6", sourceNodeId: "t", targetNodeId: "b", sourceHandle: null, targetHandle: null });
    g.nodes[2].config = { action: "send_sms", body: "" };
    const messages = activationIssues(g).map((i) => i.message).join(" | ");
    assert.match(messages, /"t" connects to more than one step/);
    assert.match(messages, /Write the SMS message/);
  });

  it("flags conditions with no path", () => {
    const g = graph();
    g.connections = g.connections.filter((c) => c.sourceNodeId !== "c");
    g.nodes = g.nodes.filter((node) => node.id === "t" || node.id === "c");
    assert.match(activationIssues(g).map((i) => i.message).join(), /needs a Yes or No path/);
  });
});
