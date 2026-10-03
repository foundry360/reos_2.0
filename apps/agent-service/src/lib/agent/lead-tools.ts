import type { ChatCompletionTool } from "openai/resources/chat/completions";
import { checkRequestedStart, findOpenSlots, type AppointmentKind } from "@/lib/calendar/calendar-core";
import { formatSlotLabel, zonedParts, type SlotPreference } from "@/lib/calendar/consult-slots";
import type { AgentBackend, ToolEvent, UpcomingAppointment } from "@/lib/agent/backend";
import { unsupportedFields } from "@/lib/agent/crm-evidence";
import { isValidEmailAddress } from "@/lib/email/email-utils";

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
          additional: {
            type: "boolean",
            description: "True only if they already have an appointment and clearly want another one, not a move",
          },
        },
        required: ["kind", "start"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "reschedule_appointment",
      description:
        "Move the lead's existing appointment to a new time. Updates the same calendar event and emails the updated invite; the old time is freed. Use this (not book_appointment) when someone with an appointment wants a different time.",
      parameters: {
        type: "object",
        properties: {
          start: {
            type: "string",
            description: 'New start from find_open_times / LAST TIMES YOU OFFERED, or "YYYY-MM-DD HH:MM" local',
          },
          current_start: {
            type: "string",
            description: "Start of the appointment to move, from UPCOMING APPOINTMENTS. Required if they have more than one.",
          },
        },
        required: ["start"],
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
  /** The lead's appointments from now on; reschedule_appointment moves one of these. */
  upcoming: UpcomingAppointment[];
  /** The lead said "yes" to several offered times without picking one. */
  ambiguousPick?: boolean;
  /** The lead's message names or points at a specific time, or a time is held for their contact info. */
  leadPickedTime?: boolean;
  /** Everything the lead has written in this conversation; CRM facts must be backed by it. */
  leadText: string;
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

function pickProblem(state: LeadTurnState, verb: "BOOKED" | "MOVED"): { ok: false; error: string } | null {
  if (state.ambiguousPick) {
    return {
      ok: false,
      error: `NOT ${verb}. You offered several times and the lead only said yes without picking one. Ask which time they want; don't act until they choose.`,
    };
  }
  if (state.leadPickedTime === false) {
    return {
      ok: false,
      error: `NOT ${verb}. The lead gave a day or range, not a specific time. Call find_open_times and offer 2-4 times with the day named; act once they pick one.`,
    };
  }
  return null;
}

const kindOf = (title: string | null): AppointmentKind => (/showing/i.test(title ?? "") ? "showing" : "consult");

async function bookAppointment(state: LeadTurnState, args: Record<string, unknown>) {
  const { backend } = state;
  if (state.booked) {
    return { ok: true, ...state.booked, note: "Already booked this turn. Do not book again." };
  }
  const notPicked = pickProblem(state, "BOOKED");
  if (notPicked) return notPicked;
  const schedule = await backend.schedule();
  const kind: AppointmentKind = args.kind === "showing" ? "showing" : "consult";
  const sameKind = state.upcoming.find((a) => kindOf(a.title) === kind);
  if (sameKind && args.additional !== true) {
    return {
      ok: false,
      error: `NOT BOOKED. They already have ${formatSlotLabel(sameKind.start, schedule.timeZone)} (start ${localStart(sameKind.start, schedule.timeZone)}). If they want to change it, call reschedule_appointment. Only if they clearly want a second appointment, call book_appointment again with additional: true.`,
    };
  }
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
  const emailInvalid = Boolean(state.email) && !isValidEmailAddress(state.email!);
  const missing = [
    state.email && !emailInvalid ? null : "email",
    state.phoneOnFile ? null : "mobile",
  ].filter((v): v is string => Boolean(v));
  if (missing.length > 0) {
    return {
      ok: false,
      needsContactInfo: missing,
      requestedLabel: label,
      start,
      error: `NOT BOOKED YET. ${label} is open and held. In one short message, name this time and ask for their ${missing.join(" and ")} to send the confirmation.${emailInvalid ? ` The email on file ("${state.email}") isn't a valid address, so ask them to confirm it.` : ""} When they reply, book this exact start.`,
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
    leadInviteSent: booked.leadInviteSent,
    attendeeEmail: booked.attendeeEmail,
    ...(booked.leadInviteSent
      ? { confirmation: `Booked ${booked.label}. A calendar invite was emailed to the lead at ${booked.attendeeEmail}.` }
      : {
          confirmation: `Booked ${booked.label}, but the lead did NOT receive a calendar invite.`,
          note: "Confirm the time, don't say an invite was sent, and ask them to double-check their email address so we can send it.",
        }),
  };
}

async function rescheduleAppointment(state: LeadTurnState, args: Record<string, unknown>) {
  const { backend } = state;
  if (state.booked) {
    return { ok: true, ...state.booked, note: "Already moved this turn. Do not move again." };
  }
  if (state.upcoming.length === 0) {
    return { ok: false, error: "They have no upcoming appointment to move. Use book_appointment for a new one." };
  }
  const schedule = await backend.schedule();
  const current = typeof args.current_start === "string" ? args.current_start.trim() : "";
  const appt = current
    ? state.upcoming.find((a) => localStart(a.start, schedule.timeZone) === current)
    : state.upcoming.length === 1
      ? state.upcoming[0]
      : null;
  if (!appt) {
    return {
      ok: false,
      error: `Say which appointment to move with current_start, one of: ${state.upcoming
        .map((a) => localStart(a.start, schedule.timeZone))
        .join(", ")}.`,
    };
  }
  const notPicked = pickProblem(state, "MOVED");
  if (notPicked) return notPicked;

  const oldStart = Date.parse(appt.start);
  const oldEnd = Date.parse(appt.end);
  const checked = checkRequestedStart({
    schedule,
    busy: (await backend.busy()).filter((b) => !(b.start === oldStart && b.end === oldEnd)),
    now: backend.now(),
    kind: kindOf(appt.title),
    start: typeof args.start === "string" ? args.start : "",
  });
  if (!checked.ok) {
    return { ok: false, error: checked.error, openTimes: checked.openTimes.map(slotViewer(schedule.timeZone)) };
  }
  if (checked.start.getTime() === oldStart) {
    return { ok: false, error: "That is already their appointment time. Nothing to move." };
  }

  const moved = await backend.reschedule({
    appointmentId: appt.id,
    start: checked.start,
    end: checked.end,
    attendeeEmail: state.email && isValidEmailAddress(state.email) ? state.email : null,
    leadName: state.leadName ?? null,
  });
  if (!moved.ok) {
    console.error("lead agent reschedule_appointment failed:", moved.error);
    return /no longer available/i.test(moved.error)
      ? moved
      : {
          ok: false,
          error: `${moved.error} This is a system problem, not availability. Apologize briefly and say the team will confirm the new time.`,
        };
  }
  const previousLabel = formatSlotLabel(appt.start, schedule.timeZone);
  appt.start = moved.start;
  appt.end = moved.end;
  state.booked = { label: moved.label, start: localStart(moved.start, schedule.timeZone) };
  return {
    ok: true,
    label: moved.label,
    start: state.booked.start,
    previousLabel,
    leadInviteSent: moved.leadInviteSent,
    ...(moved.leadInviteSent
      ? {
          confirmation: `Moved from ${previousLabel} to ${moved.label}. The updated invite was emailed to ${moved.attendeeEmail}; their calendar event moves to the new time.`,
        }
      : {
          confirmation: `Moved from ${previousLabel} to ${moved.label}, but the lead did NOT receive an updated invite.`,
          note: "Confirm the new time, don't say an invite was sent, and ask them to double-check their email address.",
        }),
  };
}

async function updateContact(state: LeadTurnState, args: Record<string, unknown>) {
  const clean = { ...args };
  delete clean.appt_booked;
  if (clean.lead_status === "Converted") delete clean.lead_status;
  const notSaved = unsupportedFields(clean, state.leadText);
  for (const field of notSaved) delete clean[field];
  let badEmail: string | null = null;
  if (typeof clean.email === "string" && !isValidEmailAddress(clean.email)) {
    badEmail = clean.email;
    delete clean.email;
  }
  if (Object.keys(clean).length > 0) {
    state.contactId =
      (await state.backend.applyToolCalls(state.contactId, [{ name: "update_contact", args: clean }])) ??
      state.contactId;
  }
  if (typeof clean.email === "string" && clean.email.includes("@")) state.email = clean.email.trim().toLowerCase();
  if (typeof clean.phone === "string" && clean.phone.replace(/\D/g, "").length >= 10) state.phoneOnFile = true;
  const notes: string[] = [];
  if (badEmail) {
    notes.push(
      `Email not saved: "${badEmail}" isn't a valid address (spaces or typo). Don't guess the fix; ask them to confirm their email.`,
    );
  }
  if (notSaved.length > 0) {
    notes.push(
      `Not saved: ${notSaved.join(", ")}. The lead hasn't said this. Only save what the lead told you; never assume, and never copy listing details (price, city, type) into their fields. Ask if it matters.`,
    );
  }
  if (notes.length > 0) {
    return { ok: true, notSaved: [...notSaved, ...(badEmail ? ["email"] : [])], note: notes.join(" ") };
  }
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
    else if (name === "reschedule_appointment") result = await rescheduleAppointment(state, args);
    else if (name === "update_contact") result = await updateContact(state, args);
    else result = { ok: false, error: `Unknown tool: ${name}` };
  } catch (error) {
    console.error("lead agent tool failed:", name, error);
    result = { ok: false, error: error instanceof Error ? error.message : "Tool failed" };
  }
  state.events.push({ name, args, result });
  return result;
}
