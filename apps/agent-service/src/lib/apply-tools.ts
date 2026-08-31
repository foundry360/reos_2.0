import type { AgentTurnResult } from "@/lib/llm/openai";
import { updateContactFields } from "@/lib/db/contacts";

const LEAD_STATUSES = new Set([
  "New",
  "Working",
  "Contacted",
  "Qualified",
  "Converted",
]);
const TEMPERATURES = new Set(["Hot", "Warm", "Cold"]);
const INTENTS = new Set(["Buyer", "Seller", "Investor", "Referral"]);

function asBool(value: unknown): boolean | undefined {
  if (typeof value === "boolean") return value;
  return undefined;
}

export async function applyToolCalls(
  contactId: string | undefined,
  toolCalls: AgentTurnResult["toolCalls"],
): Promise<void> {
  if (!contactId || toolCalls.length === 0) return;

  const fields: Record<string, string | number | boolean | null> = {};

  for (const call of toolCalls) {
    if (call.name !== "update_contact") continue;
    const args = call.args;

    if (typeof args.ai_summary === "string") fields.ai_summary = args.ai_summary;
    if (typeof args.agent_brief === "string") fields.agent_brief = args.agent_brief;
    if (typeof args.recommended_next_action === "string") {
      fields.recommended_next_action = args.recommended_next_action;
    }
    if (typeof args.email === "string" && args.email.trim()) {
      fields.email = args.email.trim();
    }

    if (typeof args.lead_status === "string" && LEAD_STATUSES.has(args.lead_status)) {
      fields.lead_status = args.lead_status;
    }
    if (
      typeof args.lead_temperature === "string" &&
      TEMPERATURES.has(args.lead_temperature)
    ) {
      fields.lead_temperature = args.lead_temperature;
    }
    if (typeof args.intent === "string" && INTENTS.has(args.intent)) {
      fields.intent = args.intent;
    }
    if (typeof args.qualification_score === "number") {
      const score = Math.round(args.qualification_score);
      if (score >= 0 && score <= 100) fields.qualification_score = score;
    }

    const ready = asBool(args.ready_to_book);
    if (ready !== undefined) fields.ready_to_book = ready;

    const booked = asBool(args.appt_booked);
    if (booked !== undefined) fields.appt_booked = booked;

    const handoff = asBool(args.handoff);
    if (handoff !== undefined) fields.handoff = handoff;

    const optedOut = asBool(args.opted_out);
    if (optedOut !== undefined) fields.opted_out = optedOut;
  }

  // Side effects for consistent coordinator routing
  if (fields.opted_out === true) {
    fields.ready_to_book = false;
  }
  if (fields.appt_booked === true) {
    fields.ready_to_book = false;
    if (!fields.lead_status) fields.lead_status = "Converted";
  }
  if (fields.ready_to_book === true) {
    if (!fields.lead_status) fields.lead_status = "Qualified";
  }
  if (
    (fields.lead_temperature === "Warm" || fields.lead_temperature === "Cold") &&
    fields.ready_to_book !== true &&
    !fields.lead_status
  ) {
    fields.lead_status = "Contacted";
  }

  if (Object.keys(fields).length > 0) {
    await updateContactFields(contactId, fields);
  }
}
