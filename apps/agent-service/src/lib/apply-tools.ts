import type { AgentTurnResult } from "@/lib/llm/openai";
import {
  ensureAiSummary,
  ensureScoreAndTemperature,
  updateContactFields,
  upsertContactSmsIdentity,
} from "@/lib/db/contacts";
import { reconcileContactByEmailOrPhone } from "@/lib/db/contact-merge";
import { DEFAULT_CONTACT_TYPE } from "@/lib/crm/contact-type";
import {
  ensureAppointmentSetOpportunity,
  syncIntakeOpportunityStage,
} from "@/lib/opportunities/create-from-booking";

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

const QUAL_FIELD_KEYS = new Set([
  "intent",
  "target_location",
  "property_type",
  "budget",
  "timeline",
  "financing_status",
  "must_haves",
  "motivation",
  "preferences",
]);

function asBool(value: unknown): boolean | undefined {
  if (typeof value === "boolean") return value;
  return undefined;
}

function asTrimmedString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function normalizeEmail(value: unknown): string | undefined {
  const raw = asTrimmedString(value)?.toLowerCase();
  if (!raw || !raw.includes("@")) return undefined;
  return raw;
}

/** Returns the surviving contact id after any email/phone merge. */
export async function applyToolCalls(
  contactId: string | undefined,
  toolCalls: AgentTurnResult["toolCalls"],
): Promise<string | undefined> {
  if (!contactId || toolCalls.length === 0) return contactId;

  let activeContactId = contactId;
  const fields: Record<string, string | number | boolean | null> = {};
  let phoneToLink: string | undefined;
  let modelWroteSummary = false;
  let modelWroteScore = false;
  let touchedQualification = false;

  for (const call of toolCalls) {
    if (call.name === "book_appointment") {
      fields.appt_booked = true;
      fields.ready_to_book = false;
      const bookedEmail = normalizeEmail(call.args.attendee_email);
      if (bookedEmail) fields.email = bookedEmail;
      continue;
    }

    if (call.name !== "update_contact") continue;
    const args = call.args;

    for (const key of STRING_FIELDS) {
      const value =
        key === "email" ? normalizeEmail(args[key]) : asTrimmedString(args[key]);
      if (value !== undefined) {
        fields[key] = value;
        if (key === "ai_summary") modelWroteSummary = true;
        if (QUAL_FIELD_KEYS.has(key)) touchedQualification = true;
      }
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
      modelWroteScore = true;
    }
    if (typeof args.intent === "string" && INTENTS.has(args.intent)) {
      fields.intent = args.intent;
      touchedQualification = true;
    }
    if (typeof args.qualification_score === "number") {
      const score = Math.round(args.qualification_score);
      if (score >= 0 && score <= 100) {
        fields.qualification_score = score;
        modelWroteScore = true;
      }
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
  if (fields.appt_booked === true || fields.lead_status === "Converted") {
    fields.ready_to_book = false;
    fields.lead_status = "Converted";
    fields.record_type = "contact";
    fields.contact_type = DEFAULT_CONTACT_TYPE;
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
    await updateContactFields(activeContactId, fields);
  }

  const emailForMerge =
    typeof fields.email === "string" ? fields.email : undefined;
  if (emailForMerge || phoneToLink) {
    activeContactId = await reconcileContactByEmailOrPhone(activeContactId, {
      email: emailForMerge,
      phone: phoneToLink,
    });
  }

  if (phoneToLink) {
    await upsertContactSmsIdentity(activeContactId, phoneToLink);
  }

  // Model often saves columns but skips ai_summary / score — rebuild from CRM fields.
  if (!modelWroteSummary && (touchedQualification || fields.appt_booked === true)) {
    await ensureAiSummary(activeContactId, { force: true });
  } else if (!modelWroteSummary) {
    await ensureAiSummary(activeContactId, { force: false });
  }

  if (!modelWroteScore && (touchedQualification || fields.appt_booked === true)) {
    await ensureScoreAndTemperature(activeContactId, { force: true });
  } else if (!modelWroteScore) {
    await ensureScoreAndTemperature(activeContactId, { force: false });
  }

  if (fields.appt_booked === true) {
    await ensureAppointmentSetOpportunity(activeContactId);
  } else if (
    touchedQualification ||
    fields.intent ||
    fields.qualification_score != null ||
    fields.lead_temperature ||
    fields.ready_to_book !== undefined ||
    fields.lead_status === "Working" ||
    fields.lead_status === "Qualified" ||
    fields.lead_status === "Contacted"
  ) {
    await syncIntakeOpportunityStage(activeContactId);
  }

  return activeContactId;
}
