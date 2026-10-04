import {
  STEP_FIELD_PATTERN,
  type ConditionRule,
  type ConditionValue,
} from "./contracts.ts";

/** Everything a condition can read. Built by the runtime; never from user input. */
export interface ExecutionContext {
  lead: Record<string, unknown> | null;
  opportunity: Record<string, unknown> | null;
  trigger: { event: string; payload: Record<string, unknown> };
  /** steps.<key>.output.<field> */
  steps: Record<string, { output: Record<string, unknown> }>;
}

export function resolveField(context: ExecutionContext, field: string): unknown {
  const step = STEP_FIELD_PATTERN.exec(field);
  if (step) {
    const [, key, name] = step;
    const entry = Object.hasOwn(context.steps, key) ? context.steps[key] : undefined;
    return entry && Object.hasOwn(entry.output, name) ? entry.output[name] : undefined;
  }
  const dot = field.indexOf(".");
  const scope = field.slice(0, dot);
  const name = field.slice(dot + 1);
  const source =
    scope === "lead"
      ? context.lead
      : scope === "opportunity"
        ? context.opportunity
        : scope === "trigger"
          ? context.trigger.payload
          : null;
  return source && Object.hasOwn(source, name) ? source[name] : undefined;
}

function isEmpty(value: unknown): boolean {
  return value === undefined || value === null || (typeof value === "string" && value.trim() === "");
}

function asNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "" && Number.isFinite(Number(value))) return Number(value);
  return null;
}

function normalize(value: unknown): string {
  if (typeof value === "boolean") return value ? "true" : "false";
  if (value === undefined || value === null) return "";
  return String(value).trim().toLowerCase();
}

function equals(actual: unknown, expected: ConditionValue): boolean {
  const a = asNumber(actual);
  const b = asNumber(expected);
  if (a !== null && b !== null && typeof actual !== "boolean" && typeof expected !== "boolean") return a === b;
  return normalize(actual) === normalize(expected);
}

/** Evaluates one rule. Missing data never throws: it is simply "empty". */
export function evaluateCondition(rule: ConditionRule, context: ExecutionContext): boolean {
  const actual = resolveField(context, rule.field);
  switch (rule.operator) {
    case "is_empty":
      return isEmpty(actual);
    case "is_not_empty":
      return !isEmpty(actual);
    case "equals":
      return equals(actual, rule.value);
    case "not_equals":
      return !equals(actual, rule.value);
    case "contains":
      return !isEmpty(actual) && normalize(actual).includes(normalize(rule.value));
    case "not_contains":
      return !normalize(actual).includes(normalize(rule.value)) || normalize(rule.value) === "";
    case "greater_than":
    case "greater_than_or_equal":
    case "less_than":
    case "less_than_or_equal": {
      const a = asNumber(actual);
      const b = asNumber(rule.value);
      if (a === null || b === null) return false;
      if (rule.operator === "greater_than") return a > b;
      if (rule.operator === "greater_than_or_equal") return a >= b;
      if (rule.operator === "less_than") return a < b;
      return a <= b;
    }
  }
}

export function evaluateAll(rules: ConditionRule[], context: ExecutionContext): boolean {
  return rules.every((rule) => evaluateCondition(rule, context));
}
