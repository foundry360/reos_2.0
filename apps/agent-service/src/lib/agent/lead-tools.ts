import type { ChatCompletionTool } from "openai/resources/chat/completions";
import { checkRequestedStart, findOpenSlots, type AppointmentKind } from "@/lib/calendar/calendar-core";
import { formatSlotLabel, zonedParts, type SlotPreference } from "@/lib/calendar/consult-slots";
import type { AgentBackend, ToolEvent } from "@/lib/agent/backend";

const CONTACT_FIELDS = {
  first_name: { type: "string" },
  last_name: { type: "string" },
  email: { type: "string" },
  phone: { type: "string", description: "Mobile number" },
  intent: { type: "string", enum: ["Buyer", "Seller", "Investor", "Referral"] },
  target_location: { type: "string", description: "City, neighborhood, or area" },
  property_type: {
    type: "string",
    description: "Single Family | Condo | Townhome | Multi-Family | Land | Commercial | Other",
  },
  budget: { type: "string" },
  timeline: {
    type: "string",
    description: "ASAP | 0-30 Days | 1-3 Months | 3-6 Months | 6+ Months | Just Exploring",
  },
  financing_status: {
    type: "string",
    description: "Cash | Pre-Approved | Pre-Qualified | Needs Financing | Unknown",
  },
  must_haves: { type: "string" },
  motivation: { type: "string" },
  preferences: { type: "string" },
  ai_summary: { type: "string", description: "2-4 factual sentences about the lead (full overwrite)" },
  agent_brief: { type: "string", description: "Notes for the human agent (full overwrite)" },
  recommended_next_action: { type: "string" },
  lead_status: { type: "string", enum: ["New", "Working", "Contacted", "Qualified"] },
  lead_temperature: { type: "string", enum: ["Hot", "Warm", "Cold"] },
  qualification_score: { type: "number", description: "0-100" },
  ready_to_book: { type: "boolean" },
  handoff: { type: "boolean", description: "Lead asked for a person, is upset, or you are stuck" },
  opted_out: { type: "boolean", description: "Lead asked to stop messages" },
} as const;

export const LEAD_TOOLS: ChatCompletionTool[] = [
  {
    type: "function",
    function: {
      name: "update_contact",
      description: "Save facts the lead shared to the CRM. Silent: never mention it in chat.",
      parameters: { type: "object", properties: CONTACT_FIELDS, additionalProperties: false },
    },
  },
  {
    type: "function",
    function: {
      name: "find_open_times",
      description:
        "Look up real open times on the team calendar. With day, returns every open time that day (narrow with after/before). Without day, returns a few times on each of the next open days.",
      parameters: {
        type: "object",
        properties: {
          kind: { type: "string", enum: ["consult", "showing"] },
          day: { type: "string", description: "YYYY-MM-DD from DATES in context" },
          after: { type: "string", description: 'Earliest start, 24h "HH:MM" local, e.g. "13:00" for afternoon' },
          before: { type: "string", description: 'Latest end, 24h "HH:MM" local, e.g. "12:00" for morning' },
        },
        required: ["kind"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "book_appointment",
      description:
        "Book a consult or showing. The server checks the time is open and that we have their contact info; if not, it returns why and nothing is booked.",
      parameters: {
        type: "object",
        properties: {
          kind: { type: "string", enum: ["consult", "showing"] },
          start: {
            type: "string",
            description: 'Exact start from find_open_times / LAST TIMES YOU OFFERED / HELD TIME, or "YYYY-MM-DD HH:MM" local',
          },
          title: { type: "string", description: '"Showing - <address>" for a showing; omit for a consult' },
        },
        required: ["kind", "start"],
        additionalProperties: false,
      },
    },
  },
];

export interface LeadTurnState {
  backend: AgentBackend;
  contactId?: string;
  email?: string;
  phoneOnFile: boolean;
  leadName?: string;
  events: ToolEvent[];
  booked: { label: string; start: string } | null;
  /** The lead said "yes" to several offered times without picking one. */
  ambiguousPick?: boolean;
  /** The lead's message names or points at a specific time, or a time is held for their contact info. */
  leadPickedTime?: boolean;
}

/** "YYYY-MM-DD HH:MM" in the workspace zone. The model only ever sees local starts, never UTC ISO. */
export function localStart(iso: string, timeZone: string): string {
  const p = zonedParts(new Date(iso), timeZone);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${p.year}-${pad(p.month)}-${pad(p.day)} ${pad(p.hour)}:${pad(p.minute)}`;
}

function slotViewer(timeZone: string) {
  return (slot: { start: string; label: string }) => ({
    label: slot.label,
    start: localStart(slot.start, timeZone),
  });
}

async function findOpenTimes(state: LeadTurnState, args: Record<string, unknown>) {
  const { backend } = state;
  const schedule = await backend.schedule();
  const kind: AppointmentKind = args.kind === "showing" ? "showing" : "consult";
  const day = typeof args.day === "string" && args.day.trim() ? args.day.trim() : undefined;
  const after = typeof args.after === "string" ? args.after : undefined;
  const before = typeof args.before === "string" ? args.before : undefined;
  const result = findOpenSlots({
    schedule,
    busy: await backend.busy(),
    now: backend.now(),
    kind,
    preference: "any" as SlotPreference,
    day,
    after,
    before,
    limit: day ? 24 : 80,
  });
  if (!result.ok) return result;

  let slots = result.slots;
  if (!day) {
    const perDay = new Map<string, typeof slots>();
    for (const slot of slots) {
      const p = zonedParts(new Date(slot.start), schedule.timeZone);
      const key = `${p.year}-${p.month}-${p.day}`;
      const list = perDay.get(key) ?? [];
      if (list.length < 4) list.push(slot);
      perDay.set(key, list);
    }
    slots = [...perDay.values()].slice(0, 4).flat();
  }
  return {
    ok: true,
    kind,
    slots: slots.map(slotViewer(schedule.timeZone)),
    ...(slots.length === 0
      ? { note: "No open times match. Try another day or widen after/before." }
      : {}),
  };
}

async function bookAppointment(state: LeadTurnState, args: Record<string, unknown>) {
  const { backend } = state;
  if (state.booked) {
    return { ok: true, ...state.booked, note: "Already booked this turn. Do not book again." };
  }
  if (state.ambiguousPick) {
    return {
      ok: false,
      error:
        "NOT BOOKED. You offered several times and the lead only said yes without picking one. Ask which time they want; don't book until they choose.",
    };
  }
  if (state.leadPickedTime === false) {
    return {
      ok: false,
      error:
        "NOT BOOKED. The lead gave a day or range, not a specific time. Call find_open_times and offer 2-4 times with the day named; book once they pick one.",
    };
  }
  const schedule = await backend.schedule();
  const kind: AppointmentKind = args.kind === "showing" ? "showing" : "consult";
  const requested = typeof args.start === "string" ? args.start : "";
  const checked = checkRequestedStart({
    schedule,
    busy: await backend.busy(),
    now: backend.now(),
    kind,
    start: requested,
  });
  if (!checked.ok) {
    return { ok: false, error: checked.error, openTimes: checked.openTimes.map(slotViewer(schedule.timeZone)) };
  }

  const start = localStart(checked.start.toISOString(), schedule.timeZone);
  const label = formatSlotLabel(checked.start.toISOString(), schedule.timeZone);
  const missing = [state.email ? null : "email", state.phoneOnFile ? null : "mobile"].filter(
    (v): v is string => Boolean(v),
  );
  if (missing.length > 0) {
    return {
      ok: false,
      needsContactInfo: missing,
      requestedLabel: label,
      start,
      error: `NOT BOOKED YET. ${label} is open and held. In one short message, name this time and ask for their ${missing.join(" and ")} to send the confirmation. When they reply, book this exact start.`,
    };
  }

  const title = typeof args.title === "string" && args.title.trim() ? args.title.trim() : null;
  const booked = await backend.book({
    contactId: state.contactId,
    start: checked.start,
    end: checked.end,
    title: title && state.leadName && !title.includes(state.leadName) ? `${title} - ${state.leadName}` : title,
    attendeeEmail: state.email ?? null,
    leadName: state.leadName ?? null,
  });
  if (!booked.ok) {
    console.error("lead agent book_appointment failed:", booked.error);
    return /no longer available/i.test(booked.error)
      ? booked
      : {
          ok: false,
          error: `${booked.error} This is a system problem, not availability. Apologize briefly and say the team will confirm the time.`,
        };
  }
  state.contactId = booked.contactId;
  state.booked = { label: booked.label, start: localStart(booked.start, schedule.timeZone) };
  state.contactId =
    (await backend.applyToolCalls(state.contactId, [
      { name: "book_appointment", args: { attendee_email: booked.attendeeEmail } },
      { name: "update_contact", args: { appt_booked: true, ready_to_book: false, handoff: false } },
    ])) ?? state.contactId;
  return {
    ok: true,
    label: booked.label,
    start: state.booked.start,
    inviteSent: booked.inviteSent,
    attendeeEmail: booked.attendeeEmail,
    confirmation: booked.confirmation,
  };
}

async function updateContact(state: LeadTurnState, args: Record<string, unknown>) {
  const clean = { ...args };
  delete clean.appt_booked;
  if (clean.lead_status === "Converted") delete clean.lead_status;
  state.contactId =
    (await state.backend.applyToolCalls(state.contactId, [{ name: "update_contact", args: clean }])) ??
    state.contactId;
  if (typeof clean.email === "string" && clean.email.includes("@")) state.email = clean.email.trim().toLowerCase();
  if (typeof clean.phone === "string" && clean.phone.replace(/\D/g, "").length >= 10) state.phoneOnFile = true;
  return { ok: true };
}

export async function runLeadTool(
  state: LeadTurnState,
  name: string,
  args: Record<string, unknown>,
): Promise<unknown> {
  let result: unknown;
  try {
    if (name === "find_open_times") result = await findOpenTimes(state, args);
    else if (name === "book_appointment") result = await bookAppointment(state, args);
    else if (name === "update_contact") result = await updateContact(state, args);
    else result = { ok: false, error: `Unknown tool: ${name}` };
  } catch (error) {
    console.error("lead agent tool failed:", name, error);
    result = { ok: false, error: error instanceof Error ? error.message : "Tool failed" };
  }
  state.events.push({ name, args, result });
  return result;
}
