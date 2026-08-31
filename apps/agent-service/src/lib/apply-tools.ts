import type { AgentTurnResult } from "@/lib/llm/openai";
import {
  updateContactFields,
  upsertContactSmsIdentity,
} from "@/lib/db/contacts";

const LEAD_STATUSES = new Set([
  "New",
  "Working",
  "Contacted",
  "Qualified",
  "Converted",
]);
const TEMPERATURES = new Set(["Hot", "Warm", "Cold"]);
const INTENTS = new Set(["Buyer", "Seller", "Investor", "Referral"]);

const STRING_FIELDS = [
  "ai_summary",
  "agent_brief",
  "recommended_next_action",
  "email",
  "first_name",
  "last_name",
  "target_location",
  "property_type",
  "budget",
  "timeline",
  "financing_status",
  "must_haves",
  "motivation",
  "preferences",
] as const;

function asBool(value: unknown): boolean | undefined {
  if (typeof value === "boolean") return value;
  return undefined;
}

function asTrimmedString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

export async function applyToolCalls(
  contactId: string | undefined,
  toolCalls: AgentTurnResult["toolCalls"],
): Promise<void> {
  if (!contactId || toolCalls.length === 0) return;

  const fields: Record<string, string | number | boolean | null> = {};
  let phoneToLink: string | undefined;

  for (const call of toolCalls) {
    if (call.name !== "update_contact") continue;
    const args = call.args;

    for (const key of STRING_FIELDS) {
      const value = asTrimmedString(args[key]);
      if (value !== undefined) fields[key] = value;
    }

    const phone = asTrimmedString(args.phone);
    if (phone) phoneToLink = phone;

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
  // Do not auto-flip to Contacted on Warm/Cold — that yanked leads out of Concierge
  // mid-intake. Concierge sets Contacted explicitly when nurturing is the outcome.
  if (!fields.lead_status && (fields.first_name || fields.intent || fields.target_location)) {
    fields.lead_status = "Working";
  }

  if (Object.keys(fields).length > 0) {
    await updateContactFields(contactId, fields);
  }

  if (phoneToLink) {
    await upsertContactSmsIdentity(contactId, phoneToLink);
  }
}
