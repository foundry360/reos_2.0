import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";
import type { JourneyAIExecutor, JourneyAIRequest } from "./ai.ts";
import { evaluateCondition, evaluateRules, type ExecutionContext } from "./conditions.ts";
import {
  conditionRules,
  LEAD_REPLIED_FIELD,
  MAX_CONDITION_RULES,
  validateNodeConfig,
  type ConditionRule,
} from "./contracts.ts";
import { dispatchJourneyEvent, resumeDueRuns, type ActionExecutor, type EngineDeps, type JourneyEvent } from "./engine.ts";
import { activationIssues, type JourneySnapshot, type SnapshotNode } from "./graph.ts";
import { MemoryJourneyStore } from "./memory-store.ts";

const context: ExecutionContext = {
  lead: { lead_status: "Qualified", lead_temperature: "Hot", intent: "Referral", qualification_score: 72, email: "", ready_to_book: false, handoff: true },
  opportunity: { stage: "Qualified" },
  trigger: { event: "lead.created", payload: {} },
  steps: { qualify: { output: { score: 0 } } },
};

const status = (value: string): ConditionRule => ({ field: "lead.lead_status", operator: "equals", value });
const temperature = (value: string): ConditionRule => ({ field: "lead.lead_temperature", operator: "equals", value });
const intent = (value: string): ConditionRule => ({ field: "lead.intent", operator: "equals", value });
const score = (operator: ConditionRule["operator"], value: number): ConditionRule => ({ field: "lead.qualification_score", operator, value });
const TRUE_RULE = status("Qualified");
const FALSE_RULE = status("New");

function validate(config: unknown, mode: "draft" | "strict" = "strict") {
  return validateNodeConfig("condition", config, mode);
}

describe("multi-rule validation", () => {
  it("leaves single-rule draft and strict behavior unchanged", () => {
    assert.deepEqual(validate(TRUE_RULE), { config: TRUE_RULE, errors: [] });
    assert.deepEqual(validate({}, "draft"), { config: { field: "", operator: "equals", value: null }, errors: [] });
    assert.deepEqual(validate({}).errors, ["Condition: choose a field.", "Condition: choose an operator."]);
    assert.match(validate({ field: "lead.ready_to_book", operator: "greater_than", value: 1 }).errors.join(" "), /^Condition: .*doesn't apply/);
  });

  it("keeps a legacy flat config flat", () => {
    for (const mode of ["draft", "strict"] as const) {
      const { config } = validate({ ...TRUE_RULE, logic: "any" }, mode);
      assert.deepEqual(config, TRUE_RULE, `${mode}: no rules or logic key is added`);
    }
  });

  it("stores two or more rules as { logic, rules }", () => {
    const { config, errors } = validate({ logic: "any", rules: [TRUE_RULE, FALSE_RULE] });
    assert.deepEqual(errors, []);
    assert.deepEqual(config, { logic: "any", rules: [TRUE_RULE, FALSE_RULE] });
  });

  it("collapses a one-rule list back to the flat shape", () => {
    assert.deepEqual(validate({ logic: "all", rules: [TRUE_RULE] }).config, TRUE_RULE);
  });

  it("rejects zero rules in strict mode; a draft keeps the empty list", () => {
    assert.deepEqual(validate({ logic: "all", rules: [] }).errors, ["Condition: add at least one rule."]);
    assert.deepEqual(validate({ logic: "all", rules: [] }, "draft"), { config: { logic: "all", rules: [] }, errors: [] });
  });

  it("rejects more than 10 rules in strict mode and caps them in drafts", () => {
    const many = Array.from({ length: 12 }, () => TRUE_RULE);
    assert.ok(validate({ logic: "all", rules: many }).errors.includes(`Condition: use at most ${MAX_CONDITION_RULES} rules.`));
    const draft = validate({ logic: "all", rules: many }, "draft").config as { rules: unknown[] };
    assert.equal(draft.rules.length, MAX_CONDITION_RULES);
    assert.deepEqual(validate({ logic: "all", rules: many.slice(0, 10) }).errors, []);
  });

  it("fails a malformed rule entry in strict mode and drops it from drafts", () => {
    const errors = validate({ logic: "all", rules: [TRUE_RULE, "status = New", null, [1]] }).errors;
    assert.deepEqual(errors, ["Rule 2 is malformed.", "Rule 3 is malformed.", "Rule 4 is malformed."]);
    assert.deepEqual(validate({ logic: "all", rules: [TRUE_RULE, "x", FALSE_RULE] }, "draft").config, {
      logic: "all",
      rules: [TRUE_RULE, FALSE_RULE],
    });
  });

  it("fails a rule list that isn't an array instead of falling back to the top-level rule", () => {
    const { config, errors } = validate({ ...TRUE_RULE, logic: "all", rules: { 0: TRUE_RULE } });
    assert.ok(errors.includes("Condition: the rule list is malformed."));
    assert.deepEqual(config, { logic: "all", rules: [] });
  });

  it("validates each rule's field, operator, and value with its rule number", () => {
    const errors = validate({
      logic: "all",
      rules: [
        TRUE_RULE,
        { field: "lead.__proto__", operator: "equals", value: "x" },
        { field: "lead.lead_status", operator: "eval", value: "x" },
        { field: "lead.ready_to_book", operator: "greater_than", value: 1 },
        { field: "lead.qualification_score", operator: "greater_than", value: "abc" },
        { field: "lead.email", operator: "equals", value: "" },
      ],
    }).errors;
    assert.deepEqual(errors, [
      "Rule 2: choose a field.",
      "Rule 3: choose an operator.",
      'Rule 4: "is greater than" doesn\'t apply to Ready to book.',
      "Rule 5: the value must be a number.",
      "Rule 6: enter a value.",
    ]);
  });

  it("keeps draft field/operator normalization per rule", () => {
    const { config } = validate({ logic: "any", rules: [TRUE_RULE, { field: "lead.nope", operator: "eval", value: 1 }] }, "draft");
    assert.deepEqual(config, { logic: "any", rules: [TRUE_RULE, { field: "", operator: "equals", value: 1 }] });
  });

  it("rejects invalid logic in strict mode; drafts normalize it to all", () => {
    assert.deepEqual(validate({ logic: "xor", rules: [TRUE_RULE, FALSE_RULE] }).errors, [
      "Condition: choose whether all or any rules must match.",
    ]);
    assert.ok(validate({ rules: [TRUE_RULE, FALSE_RULE] }).errors.length > 0, "missing logic is rejected too");
    assert.equal((validate({ logic: "xor", rules: [TRUE_RULE, FALSE_RULE] }, "draft").config as { logic: string }).logic, "all");
  });

  it("removes unknown keys at both levels", () => {
    const { config } = validate({ logic: "all", rules: [{ ...TRUE_RULE, sql: "drop" }, FALSE_RULE], expression: "1=1" });
    assert.deepEqual(config, { logic: "all", rules: [TRUE_RULE, FALSE_RULE] });
  });

  it("uses the rules list when mixed with top-level rule keys", () => {
    const { config, errors } = validate({ field: "lead.email", operator: "is_empty", value: null, logic: "any", rules: [FALSE_RULE, TRUE_RULE] });
    assert.deepEqual(errors, []);
    assert.deepEqual(config, { logic: "any", rules: [FALSE_RULE, TRUE_RULE] });
  });

  it("conditionRules reads both shapes", () => {
    assert.deepEqual(conditionRules({ ...TRUE_RULE }), { logic: "all", rules: [TRUE_RULE] });
    assert.deepEqual(conditionRules({ logic: "any", rules: [TRUE_RULE, FALSE_RULE] }), { logic: "any", rules: [TRUE_RULE, FALSE_RULE] });
    assert.deepEqual(conditionRules({ logic: "any", rules: "bad" }), { logic: "any", rules: [] });
  });
});

describe("evaluateRules", () => {
  it("ALL: true when every rule is true, false when one is false", () => {
    assert.equal(evaluateRules("all", [TRUE_RULE, temperature("Hot")], context), true);
    assert.equal(evaluateRules("all", [TRUE_RULE, FALSE_RULE], context), false);
  });

  it("ANY: true when one rule is true, false when none are", () => {
    assert.equal(evaluateRules("any", [FALSE_RULE, temperature("Hot")], context), true);
    assert.equal(evaluateRules("any", [FALSE_RULE, temperature("Cold")], context), false);
  });

  it("three or more rules", () => {
    const rules = [status("Qualified"), intent("Referral"), score("greater_than", 50)];
    assert.equal(evaluateRules("all", rules, context), true);
    for (let i = 0; i < rules.length; i++) {
      const flipped = rules.map((rule, j) => (j === i ? { ...rule, value: rule.field === "lead.qualification_score" ? 90 : "Nope" } : rule));
      assert.equal(evaluateRules("all", flipped, context), false, `rule ${i + 1} false makes ALL false`);
      assert.equal(evaluateRules("any", flipped, context), true, `the other rules keep ANY true`);
    }
    assert.equal(evaluateRules("any", [status("New"), status("Working"), status("Qualified")], context), true);
  });

  it("zero rules evaluate false for either logic", () => {
    assert.equal(evaluateRules("all", [], context), false);
    assert.equal(evaluateRules("any", [], context), false);
  });

  it("a single rule matches evaluateCondition exactly", () => {
    for (const rule of [TRUE_RULE, FALSE_RULE, score("less_than", 10), { field: "lead.email", operator: "is_empty", value: null } as ConditionRule]) {
      assert.equal(evaluateRules("all", [rule], context), evaluateCondition(rule, context));
      assert.equal(evaluateRules("any", [rule], context), evaluateCondition(rule, context));
    }
  });

  it("an unknown operator never counts as true", () => {
    const bogus = { field: "lead.lead_status", operator: "eval", value: "x" } as unknown as ConditionRule;
    assert.equal(evaluateRules("any", [bogus], context), false);
    assert.equal(evaluateRules("all", [TRUE_RULE, bogus], context), false);
  });

  describe("per-rule semantics are unchanged inside a list", () => {
    const cases: Array<[string, ConditionRule, boolean]> = [
      ["missing field equals a value", { field: "lead.timeline", operator: "equals", value: "Soon" }, false],
      ["missing field is_empty", { field: "lead.timeline", operator: "is_empty", value: null }, true],
      ["missing field is_not_empty", { field: "lead.timeline", operator: "is_not_empty", value: null }, false],
      ["not_equals on missing is true", { field: "lead.timeline", operator: "not_equals", value: "Soon" }, true],
      ["not_contains on missing is true", { field: "lead.timeline", operator: "not_contains", value: "Soon" }, true],
      ["contains on missing is false", { field: "lead.timeline", operator: "contains", value: "Soon" }, false],
      ["numeric comparison on missing is false", { field: "lead.timeline", operator: "greater_than", value: 1 }, false],
      ["empty string is empty", { field: "lead.email", operator: "is_empty", value: null }, true],
      ["false is not empty", { field: "lead.ready_to_book", operator: "is_not_empty", value: null }, true],
      ["false equals false", { field: "lead.ready_to_book", operator: "equals", value: false }, true],
      ["false equals \"false\"", { field: "lead.ready_to_book", operator: "equals", value: "false" }, true],
      ["0 is not empty", { field: "steps.qualify.output.score", operator: "is_not_empty", value: null }, true],
      ["0 equals \"0\"", { field: "steps.qualify.output.score", operator: "equals", value: "0" }, true],
      ["0 does not equal false", { field: "steps.qualify.output.score", operator: "equals", value: false }, false],
      ["numeric >", score("greater_than", 70), true],
      ["numeric <=", score("less_than_or_equal", 71), false],
      ["numeric with a non-number value", { field: "lead.qualification_score", operator: "greater_than", value: "abc" }, false],
      ["numeric string value", { field: "lead.qualification_score", operator: "greater_than_or_equal", value: "72" }, true],
    ];
    for (const [name, rule, expected] of cases) {
      it(name, () => {
        assert.equal(evaluateCondition(rule, context), expected, "single rule");
        assert.equal(evaluateRules("all", [rule, TRUE_RULE], context), expected, "inside ALL");
        assert.equal(evaluateRules("any", [rule, FALSE_RULE], context), expected, "inside ANY");
      });
    }

    it("a missing lead is empty in every rule", () => {
      const noLead = { ...context, lead: null };
      assert.equal(evaluateRules("all", [{ field: "lead.lead_status", operator: "is_empty", value: null }, { field: "lead.intent", operator: "not_equals", value: "Buyer" }], noLead), true);
      assert.equal(evaluateRules("any", [TRUE_RULE, score("greater_than", 1)], noLead), false);
    });
  });
});

// ---------- Step references ----------

function node(id: string, type: SnapshotNode["type"], name: string, config: Record<string, unknown>): SnapshotNode {
  return { id, type, name, description: "", config };
}

function link(source: string, target: string, sourceHandle: string | null = null) {
  return { id: `${source}->${target}`, sourceNodeId: source, targetNodeId: target, sourceHandle, targetHandle: null };
}

const AI_CONFIG = {
  goal: "Qualify",
  instructions: "",
  agent: "default",
  outputSchema: [{ name: "sales_ready", type: "boolean", description: "" }],
};
const ref = (nodeId: string, field: string) => `steps.${nodeId}.output.${field}`;
const trigger = node("t", "trigger", "New lead", { event: "lead.created", filters: [] });
const sms = (id: string, body = id) => node(id, "action", body, { action: "send_sms", body });

/** Trigger → AI "Qualify" → Check (rules) → yes / no */
function refJourney(rules: ConditionRule[]): JourneySnapshot {
  return {
    nodes: [trigger, node("ai", "ai", "Qualify", AI_CONFIG), node("c", "condition", "Check", { logic: "all", rules }), sms("yes"), sms("no")],
    connections: [link("t", "ai"), link("ai", "c"), link("c", "yes", "yes"), link("c", "no", "no")],
  };
}

const issuesFor = (snapshot: JourneySnapshot, nodeId = "c") =>
  activationIssues(snapshot).filter((issue) => issue.nodeId === nodeId).map((issue) => issue.message);

const salesReady: ConditionRule = { field: ref("ai", "sales_ready"), operator: "equals", value: true };

describe("step references in multi-rule conditions", () => {
  it("accepts a valid reference in rule 1 and in rule 2", () => {
    assert.deepEqual(issuesFor(refJourney([salesReady, TRUE_RULE])), []);
    assert.deepEqual(issuesFor(refJourney([TRUE_RULE, salesReady])), []);
  });

  it("blocks a downstream reference in rule 2", () => {
    assert.deepEqual(issuesFor(refJourney([TRUE_RULE, { field: ref("yes", "ok"), operator: "is_not_empty", value: null }])), [
      `"Check": Rule 2: "yes" doesn't run before this condition on every path.`,
    ]);
  });

  it("blocks a self-reference in rule 2", () => {
    assert.deepEqual(issuesFor(refJourney([TRUE_RULE, { field: ref("c", "result"), operator: "equals", value: true }])), [
      `"Check": Rule 2: a condition can't reference its own output.`,
    ]);
  });

  it("blocks an undefined output field in rule 3 and reports every bad rule", () => {
    const issues = issuesFor(
      refJourney([
        { field: ref("ai", "missing"), operator: "equals", value: true },
        TRUE_RULE,
        { field: ref("gone", "x"), operator: "equals", value: true },
      ]),
    );
    assert.deepEqual(issues, [
      `"Check": Rule 1: output field "missing" isn't defined by "Qualify".`,
      `"Check": Rule 3: the referenced journey step no longer exists.`,
    ]);
  });

  it("blocks an opposite-branch reference in rule 2", () => {
    // Trigger → Gate → (yes) AI Y / (no) AI N → Check (merge) → done
    const snapshot: JourneySnapshot = {
      nodes: [
        trigger,
        node("gate", "condition", "Gate", { ...TRUE_RULE }),
        node("aiy", "ai", "Yes side", AI_CONFIG),
        node("ain", "ai", "No side", AI_CONFIG),
        node("c", "condition", "Check", { logic: "any", rules: [TRUE_RULE, { field: ref("aiy", "sales_ready"), operator: "equals", value: true }] }),
        sms("done"),
      ],
      connections: [
        link("t", "gate"),
        link("gate", "aiy", "yes"),
        link("gate", "ain", "no"),
        link("aiy", "c"),
        link("ain", "c"),
        link("c", "done", "yes"),
      ],
    };
    assert.deepEqual(issuesFor(snapshot), [`"Check": Rule 2: "Yes side" doesn't run before this condition on every path.`]);
  });

  it("keeps single-rule messages without a rule number", () => {
    const snapshot = refJourney([]);
    snapshot.nodes[2].config = { field: ref("c", "result"), operator: "equals", value: true };
    assert.deepEqual(issuesFor(snapshot), [`"Check": a condition can't reference its own output.`]);
  });

  it("blocks activation of malformed multi-rule configs", () => {
    const snapshot = refJourney([]);
    assert.deepEqual(issuesFor(snapshot), [`"Check": Condition: add at least one rule.`]);
    snapshot.nodes[2].config = { ...TRUE_RULE, rules: "x" };
    assert.ok(issuesFor(snapshot).some((message) => message.includes("the rule list is malformed")));
    snapshot.nodes[2].config = { logic: "both", rules: [TRUE_RULE, FALSE_RULE] };
    assert.ok(issuesFor(snapshot).some((message) => message.includes("choose whether all or any")));
  });
});

// ---------- Engine ----------

const TENANT = "tenant-a";
const LEAD = "contact-1";

class RecordingActions implements ActionExecutor {
  names: string[] = [];
  async execute(action: Parameters<ActionExecutor["execute"]>[0]) {
    this.names.push(action.action === "send_sms" ? action.body : action.action);
    return { status: "completed" as const, output: { ok: true } };
  }
}

class FixedAI implements JourneyAIExecutor {
  async execute(_request: JourneyAIRequest) {
    return { success: true as const, output: { sales_ready: true }, text: "" };
  }
}

/** Trigger → [Wait →] Check(config) → yes / no */
function engineJourney(config: Record<string, unknown>, withWait = false): JourneySnapshot {
  const wait = node("w", "action", "Wait", { action: "wait", duration: 1, unit: "days" });
  return {
    nodes: [trigger, ...(withWait ? [wait] : []), node("c", "condition", "Check", config), sms("yes"), sms("no")],
    connections: [
      ...(withWait ? [link("t", "w"), link("w", "c")] : [link("t", "c")]),
      link("c", "yes", "yes"),
      link("c", "no", "no"),
    ],
  };
}

const leadEvent = (contactId = LEAD): JourneyEvent => ({
  tenantId: TENANT,
  type: "lead.created",
  sourceId: contactId,
  contactId,
  entityType: "contact",
  entityId: contactId,
  payload: {},
});

describe("engine: multi-rule conditions", () => {
  let store: MemoryJourneyStore;
  let actions: RecordingActions;
  let clock: Date;
  let deps: EngineDeps;
  let repliedLookups: number;

  beforeEach(() => {
    store = new MemoryJourneyStore();
    actions = new RecordingActions();
    clock = new Date("2026-10-01T12:00:00.000Z");
    store.clock = () => new Date(clock);
    deps = { store, actions, ai: new FixedAI(), now: () => new Date(clock) };
    store.contacts.set(LEAD, { tenantId: TENANT, lead: { lead_status: "Qualified", lead_temperature: "Warm", intent: "Referral", qualification_score: 72 } });
    repliedLookups = 0;
    const lookup = store.hasInboundMessageSince.bind(store);
    store.hasInboundMessageSince = async (...args) => {
      repliedLookups++;
      return lookup(...args);
    };
  });

  async function runOnce(config: Record<string, unknown>) {
    store.saveJourney(TENANT, "j1", engineJourney(config));
    const [outcome] = await dispatchJourneyEvent(deps, leadEvent());
    assert.equal(outcome.execution?.status, "completed");
    const steps = store.stepsFor(outcome.runId!);
    return { steps, condition: steps.filter((step) => step.nodeId === "c") };
  }

  it("runs a legacy single-rule snapshot unchanged", async () => {
    const config = { ...TRUE_RULE };
    const { condition } = await runOnce(config);
    assert.deepEqual(actions.names, ["yes"]);
    assert.deepEqual(condition[0].output, { result: true, branch: "yes" });
    assert.deepEqual(condition[0].input, config);
  });

  it("ALL takes Yes when every rule holds, No when one fails", async () => {
    await runOnce({ logic: "all", rules: [status("Qualified"), intent("Referral"), score("greater_than", 50)] });
    assert.deepEqual(actions.names, ["yes"]);
    actions.names = [];
    store.runs.clear();
    await runOnce({ logic: "all", rules: [status("Qualified"), intent("Referral"), score("greater_than", 80)] });
    assert.deepEqual(actions.names, ["no"]);
  });

  it("ANY takes Yes when one rule holds, No when none do", async () => {
    await runOnce({ logic: "any", rules: [status("Qualified"), temperature("Hot")] });
    assert.deepEqual(actions.names, ["yes"]);
    actions.names = [];
    store.runs.clear();
    await runOnce({ logic: "any", rules: [status("New"), temperature("Hot")] });
    assert.deepEqual(actions.names, ["no"]);
  });

  it("records one condition step with { result, branch } and the full config as input; only one branch runs", async () => {
    const config = { logic: "any", rules: [status("New"), temperature("Warm")] };
    const { steps, condition } = await runOnce(config);
    assert.equal(condition.length, 1);
    assert.deepEqual(condition[0].output, { result: true, branch: "yes" });
    assert.deepEqual(condition[0].input, config);
    assert.deepEqual(actions.names, ["yes"]);
    assert.equal(steps.some((step) => step.nodeId === "no"), false);
  });

  it("an empty rule list takes No", async () => {
    await runOnce({ logic: "all", rules: [] });
    assert.deepEqual(actions.names, ["no"]);
  });

  it("looks up a reply once per evaluation however many rules use it", async () => {
    store.messages.push({ tenantId: TENANT, contactId: LEAD, direction: "inbound", createdAt: "2026-10-01T12:00:00.000Z" });
    const replied: ConditionRule = { field: LEAD_REPLIED_FIELD, operator: "equals", value: true };
    await runOnce({ logic: "all", rules: [replied, status("Qualified"), { ...replied, operator: "is_not_empty", value: null }] });
    assert.equal(repliedLookups, 1);
    assert.deepEqual(actions.names, ["yes"]);
  });

  it("keeps reply isolation: another workspace's or contact's reply doesn't count", async () => {
    store.messages.push({ tenantId: "tenant-b", contactId: LEAD, direction: "inbound", createdAt: "2026-10-01T12:00:00.000Z" });
    store.messages.push({ tenantId: TENANT, contactId: "contact-2", direction: "inbound", createdAt: "2026-10-01T12:00:00.000Z" });
    const replied: ConditionRule = { field: LEAD_REPLIED_FIELD, operator: "equals", value: true };
    await runOnce({ logic: "any", rules: [replied, status("New")] });
    assert.equal(repliedLookups, 1);
    assert.deepEqual(actions.names, ["no"]);
  });

  it("makes no reply lookup when no rule uses it", async () => {
    await runOnce({ logic: "any", rules: [status("Qualified"), temperature("Hot")] });
    store.runs.clear();
    await runOnce({ ...TRUE_RULE });
    assert.equal(repliedLookups, 0);
  });

  it("a running single-rule version stays pinned; a new version can use multiple rules", async () => {
    store.saveJourney(TENANT, "j1", engineJourney({ ...TRUE_RULE }, true));
    const [first] = await dispatchJourneyEvent(deps, leadEvent());
    assert.equal(first.execution?.status, "waiting");

    const multi = { logic: "all", rules: [status("Qualified"), temperature("Hot")] };
    assert.equal(store.saveJourney(TENANT, "j1", engineJourney(multi, true)), 2);

    clock = new Date(clock.getTime() + 2 * 24 * 60 * 60_000);
    await resumeDueRuns(deps);
    assert.equal(store.runs.get(first.runId!)!.journeyVersion, 1);
    assert.deepEqual(actions.names, ["yes"], "v1's single rule (status = Qualified) still applied");

    store.contacts.set("contact-2", { tenantId: TENANT, lead: { lead_status: "Qualified", lead_temperature: "Warm" } });
    const [second] = await dispatchJourneyEvent(deps, leadEvent("contact-2"));
    assert.equal(store.runs.get(second.runId!)!.journeyVersion, 2);
    clock = new Date(clock.getTime() + 2 * 24 * 60 * 60_000);
    await resumeDueRuns(deps);
    assert.deepEqual(actions.names, ["yes", "no"], "v2's ALL rules (Warm isn't Hot) took No");
    const step = store.stepsFor(second.runId!).find((entry) => entry.nodeId === "c")!;
    assert.deepEqual(step.input, multi);
  });

  it("a saved version re-parsed on load keeps the same behavior", async () => {
    // supabase-store's parseSnapshot runs every config through draft validation on load.
    for (const config of [{ ...TRUE_RULE }, { logic: "any", rules: [status("New"), temperature("Warm")] }]) {
      const loaded = validateNodeConfig("condition", structuredClone(config), "draft").config;
      assert.deepEqual(loaded, config);
    }
  });
});
