/**
 * Node configuration contracts for executable journeys.
 *
 * Every journey_nodes.config is parsed through validateNodeConfig before it is
 * saved or executed. "draft" mode keeps only known, well-typed keys so a
 * half-configured node can still be saved; "strict" mode also requires every
 * field the runtime needs (used for activation and for saving active journeys).
 *
 * Pure module (relative imports only) so it runs under node --test.
 */

import type { JourneyNodeType } from "../journey-types.ts";

// ---------- Trigger events ----------

export const TRIGGER_EVENTS = {
  "lead.created": {
    label: "New lead created",
    description: "A lead is created from SMS, Messenger, Instagram, a post comment, or manually in REOS.",
    implemented: true,
  },
  "lead.status_changed": {
    label: "Lead status changed",
    description: "A team member changes a lead's status in REOS.",
    implemented: true,
  },
  "message.received": {
    label: "Message received",
    description: "A lead sends an SMS, Messenger, or Instagram message.",
    implemented: true,
  },
  "appointment.booked": {
    label: "Appointment booked",
    description: "The lead agent books a consult, or a team member schedules a meeting.",
    implemented: true,
  },
  "task.completed": {
    label: "Task completed",
    description: "A task linked to a lead is marked done.",
    implemented: true,
  },
  "lead.updated": {
    label: "Lead updated",
    description: "Planned: any lead field changes.",
    implemented: false,
  },
  "appointment.completed": {
    label: "Appointment completed",
    description: "Planned: REOS has no attended/completed appointment state yet.",
    implemented: false,
  },
  manual: {
    label: "Manual enrollment",
    description: "Planned: a team member enrolls a lead by hand.",
    implemented: false,
  },
} as const;

export type TriggerEventType = keyof typeof TRIGGER_EVENTS;

export function isTriggerEventType(value: unknown): value is TriggerEventType {
  return typeof value === "string" && Object.hasOwn(TRIGGER_EVENTS, value);
}

export function isImplementedTriggerEvent(value: unknown): value is TriggerEventType {
  return isTriggerEventType(value) && TRIGGER_EVENTS[value].implemented;
}

export const IMPLEMENTED_TRIGGER_EVENTS = (Object.keys(TRIGGER_EVENTS) as TriggerEventType[]).filter(
  (event) => TRIGGER_EVENTS[event].implemented,
);

// ---------- Condition fields and operators ----------

export type FieldType = "string" | "number" | "boolean" | "enum";

export interface FieldDefinition {
  label: string;
  type: FieldType;
  options?: readonly string[];
  /** Only meaningful for these trigger events (undefined = always). */
  events?: readonly TriggerEventType[];
}

const LEAD_STATUSES = ["New", "Working", "Contacted", "Qualified", "Converted"] as const;
const TEMPERATURES = ["Hot", "Warm", "Cold"] as const;
const INTENTS = ["Buyer", "Seller", "Investor", "Referral"] as const;
const OPPORTUNITY_STAGES = [
  "New",
  "AI_Qualifying",
  "Qualified",
  "Appointment_Set",
  "Nurture",
  "Closed_Won",
] as const;

/** The only data a condition or trigger filter may read. No expressions, no arbitrary paths. */
export const CONDITION_FIELDS: Record<string, FieldDefinition> = {
  "lead.lead_status": { label: "Lead status", type: "enum", options: LEAD_STATUSES },
  "lead.lead_temperature": { label: "Temperature", type: "enum", options: TEMPERATURES },
  "lead.intent": { label: "Intent", type: "enum", options: INTENTS },
  "lead.qualification_score": { label: "Qualification score", type: "number" },
  "lead.ready_to_book": { label: "Ready to book", type: "boolean" },
  "lead.appt_booked": { label: "Appointment booked", type: "boolean" },
  "lead.handoff": { label: "Handed off to a person", type: "boolean" },
  "lead.opted_out": { label: "Opted out of SMS", type: "boolean" },
  "lead.has_phone": { label: "Has a mobile number", type: "boolean" },
  "lead.email": { label: "Email", type: "string" },
  "lead.assigned_agent_id": { label: "Assigned agent", type: "string" },
  "lead.target_location": { label: "Target area", type: "string" },
  "lead.property_type": { label: "Property type", type: "string" },
  "lead.budget": { label: "Budget", type: "string" },
  "lead.timeline": { label: "Timeline", type: "string" },
  "lead.financing_status": { label: "Financing", type: "string" },
  "opportunity.stage": { label: "Opportunity stage", type: "enum", options: OPPORTUNITY_STAGES },
  "trigger.channel": {
    label: "Message channel",
    type: "enum",
    options: ["sms", "messenger", "instagram"],
    events: ["message.received", "lead.created"],
  },
  "trigger.body": { label: "Message text", type: "string", events: ["message.received"] },
  "trigger.from_status": {
    label: "Previous status",
    type: "enum",
    options: LEAD_STATUSES,
    events: ["lead.status_changed"],
  },
  "trigger.to_status": {
    label: "New status",
    type: "enum",
    options: LEAD_STATUSES,
    events: ["lead.status_changed"],
  },
};

/** steps.<node key>.output.<field> reads a previous step's recorded output. */
export const STEP_FIELD_PATTERN = /^steps\.([a-z0-9_]{1,60})\.output\.([a-z0-9_]{1,60})$/;

export function isConditionField(value: unknown): value is string {
  return typeof value === "string" && (Object.hasOwn(CONDITION_FIELDS, value) || STEP_FIELD_PATTERN.test(value));
}

export function fieldType(field: string): FieldType | null {
  if (Object.hasOwn(CONDITION_FIELDS, field)) return CONDITION_FIELDS[field].type;
  return STEP_FIELD_PATTERN.test(field) ? "string" : null;
}

export const CONDITION_OPERATORS = {
  equals: { label: "equals", needsValue: true, types: ["string", "number", "boolean", "enum"] },
  not_equals: { label: "does not equal", needsValue: true, types: ["string", "number", "boolean", "enum"] },
  contains: { label: "contains", needsValue: true, types: ["string"] },
  not_contains: { label: "does not contain", needsValue: true, types: ["string"] },
  is_empty: { label: "is empty", needsValue: false, types: ["string", "number", "boolean", "enum"] },
  is_not_empty: { label: "is not empty", needsValue: false, types: ["string", "number", "boolean", "enum"] },
  greater_than: { label: "is greater than", needsValue: true, types: ["number"] },
  greater_than_or_equal: { label: "is at least", needsValue: true, types: ["number"] },
  less_than: { label: "is less than", needsValue: true, types: ["number"] },
  less_than_or_equal: { label: "is at most", needsValue: true, types: ["number"] },
} as const satisfies Record<string, { label: string; needsValue: boolean; types: readonly FieldType[] }>;

export type ConditionOperator = keyof typeof CONDITION_OPERATORS;

export function isConditionOperator(value: unknown): value is ConditionOperator {
  return typeof value === "string" && Object.hasOwn(CONDITION_OPERATORS, value);
}

/** Step outputs are free-form, so every operator is allowed on them. */
export function operatorsForField(field: string): ConditionOperator[] {
  const type = fieldType(field);
  const all = Object.keys(CONDITION_OPERATORS) as ConditionOperator[];
  if (!type || STEP_FIELD_PATTERN.test(field)) return all;
  return all.filter((op) => (CONDITION_OPERATORS[op].types as readonly FieldType[]).includes(type));
}

export type ConditionValue = string | number | boolean | null;

export interface ConditionRule {
  field: string;
  operator: ConditionOperator;
  value: ConditionValue;
}

// ---------- Actions ----------

export const UPDATE_LEAD_FIELDS = {
  lead_status: { label: "Lead status", type: "enum", options: LEAD_STATUSES },
  lead_temperature: { label: "Temperature", type: "enum", options: TEMPERATURES },
  intent: { label: "Intent", type: "enum", options: INTENTS },
  qualification_score: { label: "Qualification score", type: "number" },
  ready_to_book: { label: "Ready to book", type: "boolean" },
  handoff: { label: "Hand off to a person", type: "boolean" },
  recommended_next_action: { label: "Recommended next action", type: "string" },
} as const satisfies Record<string, FieldDefinition>;

export type UpdateLeadField = keyof typeof UPDATE_LEAD_FIELDS;

export const WAIT_UNITS = ["minutes", "hours", "days"] as const;
export type WaitUnit = (typeof WAIT_UNITS)[number];
export const WAIT_LIMITS: Record<WaitUnit, number> = { minutes: 60 * 24 * 90, hours: 24 * 90, days: 90 };

export const ACTION_TYPES = {
  send_sms: { label: "Send SMS", description: "Text the lead from your primary REOS number." },
  send_email: { label: "Send email", description: "Email the lead from REOS on behalf of their agent." },
  assign_lead: { label: "Assign lead", description: "Assign the lead to a team member." },
  create_task: { label: "Create task", description: "Create a task linked to the lead." },
  update_lead: { label: "Update lead", description: "Set CRM fields on the lead." },
  notify_team: { label: "Notify team", description: "Send an in-app notification." },
  wait: { label: "Wait", description: "Pause the journey, then continue." },
} as const;

export type JourneyActionType = keyof typeof ACTION_TYPES;

export function isJourneyActionType(value: unknown): value is JourneyActionType {
  return typeof value === "string" && Object.hasOwn(ACTION_TYPES, value);
}

export const NOTIFY_RECIPIENTS = ["assigned_agent", "all_members"] as const;

export type ActionConfig =
  | { action: "send_sms"; body: string }
  | { action: "send_email"; subject: string; body: string }
  | { action: "assign_lead"; agentUserId: string }
  | { action: "create_task"; title: string; notes: string; dueInDays: number | null }
  | { action: "update_lead"; fields: Partial<Record<UpdateLeadField, string | number | boolean>> }
  | { action: "notify_team"; title: string; body: string; recipients: (typeof NOTIFY_RECIPIENTS)[number] }
  | { action: "wait"; duration: number; unit: WaitUnit };

export interface TriggerConfig {
  event: TriggerEventType;
  filters: ConditionRule[];
}

export const AI_OUTPUT_TYPES = ["string", "number", "boolean"] as const;
export type AIOutputType = (typeof AI_OUTPUT_TYPES)[number];

export interface AIOutputField {
  name: string;
  /** "" only in drafts; activation requires a type. */
  type: AIOutputType | "";
  description: string;
}

/** Output field names double as condition paths (steps.<key>.output.<name>). */
export const AI_OUTPUT_NAME_PATTERN = /^[a-z][a-z0-9_]{0,59}$/;
export const MAX_AI_OUTPUT_FIELDS = 20;
/** Step output key holding the AI's plain-language explanation. */
export const AI_TEXT_KEY = "ai_response";

export interface AIConfig {
  /** What the AI step should accomplish. */
  goal: string;
  instructions: string;
  /** Router key for the agent that runs this step. Never a model name. */
  agent: string;
  /** Optional. When present, the AI must return exactly these fields. */
  outputSchema?: AIOutputField[];
}

/** The well-formed fields of an AI node's schema; empty means freeform output. */
export function aiOutputSchema(config: Partial<AIConfig>): Array<AIOutputField & { type: AIOutputType }> {
  const fields = Array.isArray(config.outputSchema) ? config.outputSchema : [];
  const seen = new Set<string>();
  const usable: Array<AIOutputField & { type: AIOutputType }> = [];
  for (const field of fields.slice(0, MAX_AI_OUTPUT_FIELDS)) {
    const name = typeof field?.name === "string" ? field.name : "";
    const type = AI_OUTPUT_TYPES.includes(field?.type as AIOutputType) ? (field.type as AIOutputType) : null;
    if (!type || !AI_OUTPUT_NAME_PATTERN.test(name) || name === AI_TEXT_KEY || seen.has(name)) continue;
    seen.add(name);
    usable.push({ name, type, description: typeof field.description === "string" ? field.description : "" });
  }
  return usable;
}

export type ConditionConfig = ConditionRule;

export const SMS_MAX = 1000;
export const EMAIL_SUBJECT_MAX = 200;
export const EMAIL_BODY_MAX = 10000;
export const TEXT_MAX = 500;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ---------- Validation ----------

export type ValidationMode = "draft" | "strict";

export interface ConfigValidation<T = Record<string, unknown>> {
  config: T;
  errors: string[];
}

function str(value: unknown, max: number): string {
  return typeof value === "string" ? value.slice(0, max) : "";
}

function num(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "" && Number.isFinite(Number(value))) return Number(value);
  return null;
}

function conditionValue(value: unknown): ConditionValue {
  if (typeof value === "string") return value.slice(0, TEXT_MAX);
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "boolean") return value;
  return null;
}

function parseRule(raw: unknown, mode: ValidationMode, label: string): { rule: ConditionRule | null; errors: string[] } {
  const errors: string[] = [];
  const input = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const field = isConditionField(input.field) ? input.field : "";
  const operator = isConditionOperator(input.operator) ? input.operator : null;
  const value = conditionValue(input.value);

  if (mode === "strict") {
    if (!field) errors.push(`${label}: choose a field.`);
    if (!operator) errors.push(`${label}: choose an operator.`);
    if (field && operator && !operatorsForField(field).includes(operator)) {
      errors.push(`${label}: "${CONDITION_OPERATORS[operator].label}" doesn't apply to ${CONDITION_FIELDS[field]?.label ?? field}.`);
    }
    if (operator && CONDITION_OPERATORS[operator].needsValue && (value === null || value === "")) {
      errors.push(`${label}: enter a value.`);
    }
    if (operator && fieldType(field) === "number" && CONDITION_OPERATORS[operator].needsValue && num(value) === null) {
      errors.push(`${label}: the value must be a number.`);
    }
  }
  if (!field && !operator && value === null) return { rule: null, errors };
  return { rule: { field, operator: operator ?? "equals", value }, errors };
}

function validateTrigger(raw: Record<string, unknown>, mode: ValidationMode): ConfigValidation<TriggerConfig> {
  const errors: string[] = [];
  const event = isTriggerEventType(raw.event) ? raw.event : null;
  if (mode === "strict") {
    if (!event) errors.push("Choose the event that starts this journey.");
    else if (!TRIGGER_EVENTS[event].implemented) errors.push(`"${TRIGGER_EVENTS[event].label}" isn't available yet.`);
  }
  const filters: ConditionRule[] = [];
  const rawFilters = Array.isArray(raw.filters) ? raw.filters.slice(0, 10) : [];
  rawFilters.forEach((entry, index) => {
    const parsed = parseRule(entry, mode, `Filter ${index + 1}`);
    errors.push(...parsed.errors);
    if (parsed.rule) filters.push(parsed.rule);
  });
  return { config: { event: (event ?? "") as TriggerEventType, filters }, errors };
}

function validateCondition(raw: Record<string, unknown>, mode: ValidationMode): ConfigValidation<ConditionConfig> {
  const parsed = parseRule(raw, mode, "Condition");
  return {
    config: parsed.rule ?? { field: "", operator: "equals", value: null },
    errors: parsed.errors,
  };
}

function validateAI(raw: Record<string, unknown>, mode: ValidationMode): ConfigValidation<AIConfig> {
  const goal = str(raw.goal, TEXT_MAX).trim() ? str(raw.goal, TEXT_MAX) : "";
  const errors: string[] = [];
  if (mode === "strict" && !goal.trim()) errors.push("Describe the AI step's goal.");
  const agent = typeof raw.agent === "string" && /^[a-z0-9_.-]{1,60}$/.test(raw.agent) ? raw.agent : "default";
  const config: AIConfig = { goal, instructions: str(raw.instructions, 2000), agent };

  // Drafts keep half-typed fields so editing isn't lost; activation flags them.
  const rawFields = Array.isArray(raw.outputSchema) ? raw.outputSchema.slice(0, MAX_AI_OUTPUT_FIELDS) : [];
  const outputSchema: AIOutputField[] = rawFields.map((entry) => {
    const input = entry && typeof entry === "object" ? (entry as Record<string, unknown>) : {};
    return {
      name: str(input.name, 60).trim(),
      type: AI_OUTPUT_TYPES.includes(input.type as AIOutputType) ? (input.type as AIOutputType) : "",
      description: str(input.description, 300),
    };
  });
  if (outputSchema.length > 0) config.outputSchema = outputSchema;

  if (mode === "strict") {
    const counts = new Map<string, number>();
    for (const field of outputSchema) counts.set(field.name, (counts.get(field.name) ?? 0) + 1);
    outputSchema.forEach((field, index) => {
      const label = field.name ? `Output field "${field.name}"` : `Output field ${index + 1}`;
      if (!field.name) errors.push(`${label}: enter a name.`);
      else if (field.name === AI_TEXT_KEY) errors.push(`${label}: "${AI_TEXT_KEY}" is reserved for the AI's explanation.`);
      else if (!AI_OUTPUT_NAME_PATTERN.test(field.name)) {
        errors.push(`${label}: use lowercase letters, numbers, and underscores, starting with a letter.`);
      }
      if (field.name && (counts.get(field.name) ?? 0) > 1 && outputSchema.findIndex((f) => f.name === field.name) === index) {
        errors.push(`${label} is used more than once.`);
      }
      if (!field.type) errors.push(`${label}: choose a type.`);
    });
  }
  return { config, errors };
}

function validateAction(raw: Record<string, unknown>, mode: ValidationMode): ConfigValidation<ActionConfig | { action: "" }> {
  const errors: string[] = [];
  const action = isJourneyActionType(raw.action) ? raw.action : null;
  if (!action) {
    if (mode === "strict") errors.push("Choose what this action does.");
    return { config: { action: "" }, errors };
  }
  const need = (ok: boolean, message: string) => {
    if (mode === "strict" && !ok) errors.push(message);
  };

  switch (action) {
    case "send_sms": {
      const body = str(raw.body, SMS_MAX);
      need(Boolean(body.trim()), "Write the SMS message.");
      return { config: { action, body }, errors };
    }
    case "send_email": {
      const subject = str(raw.subject, EMAIL_SUBJECT_MAX);
      const body = str(raw.body, EMAIL_BODY_MAX);
      need(Boolean(subject.trim()), "Enter an email subject.");
      need(Boolean(body.trim()), "Write the email body.");
      return { config: { action, subject, body }, errors };
    }
    case "assign_lead": {
      const agentUserId = typeof raw.agentUserId === "string" && UUID.test(raw.agentUserId) ? raw.agentUserId : "";
      need(Boolean(agentUserId), "Choose who to assign the lead to.");
      return { config: { action, agentUserId }, errors };
    }
    case "create_task": {
      const title = str(raw.title, 200);
      const days = num(raw.dueInDays);
      const dueInDays = days === null ? null : Math.max(0, Math.min(365, Math.round(days)));
      need(Boolean(title.trim()), "Enter a task title.");
      return { config: { action, title, notes: str(raw.notes, 2000), dueInDays }, errors };
    }
    case "update_lead": {
      const input = raw.fields && typeof raw.fields === "object" ? (raw.fields as Record<string, unknown>) : {};
      const fields: Partial<Record<UpdateLeadField, string | number | boolean>> = {};
      for (const key of Object.keys(UPDATE_LEAD_FIELDS) as UpdateLeadField[]) {
        if (!(key in input)) continue;
        const def: FieldDefinition = UPDATE_LEAD_FIELDS[key];
        const value = input[key];
        if (def.type === "boolean" && typeof value === "boolean") fields[key] = value;
        else if (def.type === "number" && num(value) !== null) {
          fields[key] = Math.max(0, Math.min(100, Math.round(num(value)!)));
        } else if (def.type === "enum" && typeof value === "string" && def.options?.includes(value)) fields[key] = value;
        else if (def.type === "string" && typeof value === "string" && value.trim()) fields[key] = value.slice(0, TEXT_MAX);
      }
      need(Object.keys(fields).length > 0, "Choose at least one field to update.");
      return { config: { action, fields }, errors };
    }
    case "notify_team": {
      const title = str(raw.title, 200);
      const recipients = NOTIFY_RECIPIENTS.includes(raw.recipients as (typeof NOTIFY_RECIPIENTS)[number])
        ? (raw.recipients as (typeof NOTIFY_RECIPIENTS)[number])
        : "assigned_agent";
      need(Boolean(title.trim()), "Enter the notification title.");
      return { config: { action, title, body: str(raw.body, TEXT_MAX), recipients }, errors };
    }
    case "wait": {
      const unit = WAIT_UNITS.includes(raw.unit as WaitUnit) ? (raw.unit as WaitUnit) : "days";
      const value = num(raw.duration);
      const duration = value === null ? 0 : Math.round(value);
      need(duration >= 1, "Wait at least 1 " + unit.replace(/s$/, "") + ".");
      need(duration <= WAIT_LIMITS[unit], `Wait at most ${WAIT_LIMITS[unit]} ${unit}.`);
      return { config: { action, duration: Math.max(0, Math.min(WAIT_LIMITS[unit], duration)), unit }, errors };
    }
  }
}

/** Parse untrusted config for a node type. Unknown keys are dropped in every mode. */
export function validateNodeConfig(
  type: JourneyNodeType,
  config: unknown,
  mode: ValidationMode,
): ConfigValidation {
  const raw = config && typeof config === "object" && !Array.isArray(config) ? (config as Record<string, unknown>) : {};
  const result =
    type === "trigger"
      ? validateTrigger(raw, mode)
      : type === "condition"
        ? validateCondition(raw, mode)
        : type === "ai"
          ? validateAI(raw, mode)
          : validateAction(raw, mode);
  return { config: result.config as unknown as Record<string, unknown>, errors: result.errors };
}

export function waitMilliseconds(duration: number, unit: WaitUnit): number {
  const minute = 60_000;
  return duration * (unit === "minutes" ? minute : unit === "hours" ? 60 * minute : 24 * 60 * minute);
}

// ---------- Message templates ----------

/** The only placeholders a message may use. Unknown placeholders are left as typed. */
export const TEMPLATE_TOKENS = ["first_name", "last_name", "full_name"] as const;

export function renderTemplate(
  text: string,
  values: { first_name?: string | null; last_name?: string | null },
): string {
  const first = values.first_name?.trim() || "";
  const last = values.last_name?.trim() || "";
  const map: Record<string, string> = {
    first_name: first || "there",
    last_name: last,
    full_name: [first, last].filter(Boolean).join(" ") || "there",
  };
  return text.replace(/\{\{\s*([a-z_]+)\s*\}\}/g, (match, token: string) =>
    Object.hasOwn(map, token) ? map[token] : match,
  );
}

/** Stable key for referencing a step's output: "Qualify lead" -> "qualify_lead". */
export function stepKey(name: string, fallback: string): string {
  const key = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 60);
  return key || fallback.replace(/-/g, "_").slice(0, 60);
}
