import {
  MAX_INPUTS_BYTES,
  STEP_CHILD_FIELD_PATTERN,
  STEP_FIELD_PATTERN,
  STEP_ORCHESTRATION_FIELD_PATTERN,
  STEP_RESULT_FIELD_PATTERN,
  TRIGGER_INPUT_FIELD_PATTERN,
  type ConditionLogic,
  type ConditionRule,
  type ConditionValue,
  type InputMapping,
  type InputValue,
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
  const result = STEP_RESULT_FIELD_PATTERN.exec(field);
  if (result) {
    const [, key, name] = result;
    const entry = Object.hasOwn(context.steps, key) ? context.steps[key] : undefined;
    const results = entry && Object.hasOwn(entry.output, "results") ? entry.output.results : undefined;
    if (!results || typeof results !== "object" || Array.isArray(results)) return undefined;
    return Object.hasOwn(results, name) ? (results as Record<string, unknown>)[name] : undefined;
  }
  const child = STEP_CHILD_FIELD_PATTERN.exec(field);
  if (child) {
    const [, key, childKey, name] = child;
    const entry = Object.hasOwn(context.steps, key) ? context.steps[key] : undefined;
    const record = ownObject(ownObject(entry?.output, "children"), childKey);
    if (!name.startsWith("results.")) return record && Object.hasOwn(record, name) ? record[name] : undefined;
    const results = ownObject(record, "results");
    const resultName = name.slice("results.".length);
    return results && Object.hasOwn(results, resultName) ? results[resultName] : undefined;
  }
  const orchestration = STEP_ORCHESTRATION_FIELD_PATTERN.exec(field);
  if (orchestration) {
    const [, key, name] = orchestration;
    const entry = Object.hasOwn(context.steps, key) ? context.steps[key] : undefined;
    const record = ownObject(entry?.output, "orchestration");
    return record && Object.hasOwn(record, name) ? record[name] : undefined;
  }
  const input = TRIGGER_INPUT_FIELD_PATTERN.exec(field);
  if (input) {
    const inputs = context.trigger.event === "journey.started" ? context.trigger.payload.inputs : undefined;
    if (!inputs || typeof inputs !== "object" || Array.isArray(inputs)) return undefined;
    return Object.hasOwn(inputs, input[1]) ? (inputs as Record<string, unknown>)[input[1]] : undefined;
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

/** `value[key]` when it is an own plain object; otherwise undefined. */
function ownObject(value: unknown, key: string): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value) || !Object.hasOwn(value, key)) return undefined;
  const next = (value as Record<string, unknown>)[key];
  return next && typeof next === "object" && !Array.isArray(next) ? (next as Record<string, unknown>) : undefined;
}

export type JourneyInputsResult =
  | { ok: true; inputs: Record<string, InputValue> }
  | { ok: false; reason: "inputs_invalid"; errors: string[] }
  | { ok: false; reason: "inputs_too_large"; bytes: number };

/**
 * The inputs a Start journey step passes: exactly one entry per mapping, each
 * the value `resolve` returns for its source. A missing value is null. Only
 * text, finite numbers, and yes/no pass; any other value, or a result over
 * MAX_INPUTS_BYTES, passes nothing.
 */
export function journeyInputs(mappings: InputMapping[], resolve: (source: string) => unknown): JourneyInputsResult {
  const result = scalarValues(mappings, resolve, "Input");
  if (result.ok) return { ok: true, inputs: result.values };
  return result.reason === "invalid"
    ? { ok: false, reason: "inputs_invalid", errors: result.errors }
    : { ok: false, reason: "inputs_too_large", bytes: result.bytes };
}

export type ScalarValuesResult =
  | { ok: true; values: Record<string, InputValue> }
  | { ok: false; reason: "invalid"; errors: string[] }
  | { ok: false; reason: "too_large"; bytes: number };

/**
 * Values that may cross between journeys (inputs one way, results the other):
 * exactly one entry per target, each the value `resolve` returns for its
 * source. A missing value is null. Only text, finite numbers, and yes/no; any
 * other value, or a total over MAX_INPUTS_BYTES (= MAX_RESULTS_BYTES), yields
 * no values at all.
 */
export function scalarValues(
  entries: Array<{ target: string; source: string }>,
  resolve: (source: string) => unknown,
  item: string,
): ScalarValuesResult {
  const values: Record<string, InputValue> = {};
  const errors: string[] = [];
  for (const { target, source } of entries) {
    const value = resolve(source);
    if (value === undefined || value === null) values[target] = null;
    else if (typeof value === "string" || typeof value === "boolean") values[target] = value;
    else if (typeof value === "number" && Number.isFinite(value)) values[target] = value;
    else errors.push(`${item} "${target}": the value isn't text, a number, or yes/no.`);
  }
  if (errors.length > 0) return { ok: false, reason: "invalid", errors };
  const bytes = new TextEncoder().encode(JSON.stringify(values)).length;
  if (bytes > MAX_INPUTS_BYTES) return { ok: false, reason: "too_large", bytes };
  return { ok: true, values };
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

/** A Condition step's rules. No rules is false for either logic, never vacuously true. */
export function evaluateRules(logic: ConditionLogic, rules: ConditionRule[], context: ExecutionContext): boolean {
  if (rules.length === 0) return false;
  return logic === "any"
    ? rules.some((rule) => evaluateCondition(rule, context) === true)
    : rules.every((rule) => evaluateCondition(rule, context) === true);
}
