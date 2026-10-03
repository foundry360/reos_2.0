import { getSupabaseAdmin } from "@/lib/supabase/admin";
import { markConsultBooked } from "@/lib/db/contacts";
import {
  CONSULT_MINUTES,
  DEFAULT_TIME_ZONE,
  LOOKAHEAD_DAYS,
  SLOT_STEP_MINUTES,
  formatSlotLabel,
  generateConsultSlots,
  isBookableStart,
  overlapsBusy,
  parseRequestedStart,
  zonedParts,
  type BusyInterval,
  type CalendarSlot,
  type SlotPreference,
} from "@/lib/calendar/consult-slots";
import {
  resolveAssignedAgentUserId,
  sendAppointmentInvites,
} from "@/lib/calendar/appointment-invites";
import { isValidEmailAddress } from "@/lib/email/email-utils";
import {
  bookingWindowsFor,
  normalizeWorkingHours,
  type WorkingHours,
} from "@/lib/calendar/working-hours";

export type { CalendarSlot, SlotPreference };

const APPOINTMENT_DEFAULT_MINUTES = CONSULT_MINUTES;

export async function loadTenantTimezone(tenantId: string): Promise<string> {
  const db = getSupabaseAdmin();
  if (!db) return DEFAULT_TIME_ZONE;
  const { data } = await db
    .from("tenants")
    .select("timezone")
    .eq("id", tenantId)
    .maybeSingle();
  const tz = data?.timezone?.trim();
  return tz || DEFAULT_TIME_ZONE;
}

export async function loadTenantSchedule(
  tenantId: string,
): Promise<{ timeZone: string; workingHours: WorkingHours }> {
  const db = getSupabaseAdmin();
  if (!db) return { timeZone: DEFAULT_TIME_ZONE, workingHours: normalizeWorkingHours(null) };
  const { data, error } = await db
    .from("tenants")
    .select("timezone, working_hours")
    .eq("id", tenantId)
    .maybeSingle();
  if (error) {
    // working_hours column not migrated yet
    return { timeZone: await loadTenantTimezone(tenantId), workingHours: normalizeWorkingHours(null) };
  }
  return {
    timeZone: data?.timezone?.trim() || DEFAULT_TIME_ZONE,
    workingHours: normalizeWorkingHours(data?.working_hours),
  };
}

/**
 * Busy intervals from REOS calendar data (timed appointments + timed tasks).
 * Does not call Google.
 */
export async function loadReosBusyIntervals(
  tenantId: string,
  rangeStart: Date,
  rangeEnd: Date,
): Promise<BusyInterval[]> {
  const db = getSupabaseAdmin();
  if (!db) return [];

  const busy: BusyInterval[] = [];
  const rangeStartIso = rangeStart.toISOString();
  const rangeEndIso = rangeEnd.toISOString();

  const { data: activities, error: activityError } = await db
    .from("contact_activities")
    .select("occurred_at, ends_at, activity_type")
    .eq("tenant_id", tenantId)
    .in("activity_type", ["appointment", "meeting"])
    .gte("occurred_at", new Date(rangeStart.getTime() - 24 * 60 * 60 * 1000).toISOString())
    .lte("occurred_at", rangeEndIso)
    .limit(500);

  if (activityError && /ends_at|schema cache|column/i.test(activityError.message)) {
    const legacy = await db
      .from("contact_activities")
      .select("occurred_at, activity_type")
      .eq("tenant_id", tenantId)
      .in("activity_type", ["appointment", "meeting"])
      .gte("occurred_at", rangeStartIso)
      .lte("occurred_at", rangeEndIso)
      .limit(500);
    if (legacy.error) {
      console.warn("REOS busy appointments lookup failed:", legacy.error.message);
    } else {
      for (const row of legacy.data ?? []) {
        const start = new Date(row.occurred_at).getTime();
        if (Number.isNaN(start)) continue;
        const end = start + APPOINTMENT_DEFAULT_MINUTES * 60 * 1000;
        if (start < rangeEnd.getTime() && end > rangeStart.getTime()) {
          busy.push({ start, end });
        }
      }
    }
  } else if (activityError) {
    console.warn("REOS busy appointments lookup failed:", activityError.message);
  } else {
    for (const row of activities ?? []) {
      const start = new Date(row.occurred_at).getTime();
      if (Number.isNaN(start)) continue;
      const end = row.ends_at
        ? new Date(row.ends_at).getTime()
        : start + APPOINTMENT_DEFAULT_MINUTES * 60 * 1000;
      if (Number.isNaN(end) || end <= start) continue;
      if (start < rangeEnd.getTime() && end > rangeStart.getTime()) {
        busy.push({ start, end });
      }
    }
  }

  const { data: tasks, error: taskError } = await db
    .from("tasks")
    .select("start_at, end_at, due_at")
    .eq("tenant_id", tenantId)
    .limit(500);

  if (taskError && !/start_at|end_at|schema cache|column/i.test(taskError.message)) {
    console.warn("REOS busy tasks lookup failed:", taskError.message);
  } else {
    for (const row of tasks ?? []) {
      let startMs: number;
      let endMs: number;
      if (row.start_at) {
        startMs = new Date(row.start_at).getTime();
        endMs = row.end_at
          ? new Date(row.end_at).getTime()
          : startMs + APPOINTMENT_DEFAULT_MINUTES * 60 * 1000;
      } else if (row.due_at) {
        startMs = new Date(row.due_at).getTime();
        endMs = startMs + APPOINTMENT_DEFAULT_MINUTES * 60 * 1000;
      } else {
        continue;
      }
      if (Number.isNaN(startMs) || Number.isNaN(endMs)) continue;
      if (startMs < rangeEnd.getTime() && endMs > rangeStart.getTime()) {
        busy.push({ start: startMs, end: endMs });
      }
    }
  }

  return busy;
}

/** Offer consult slots from REOS calendar availability (no Google required). */
export async function getAvailableReosConsultSlots(params: {
  tenantId: string;
  preference?: SlotPreference;
  day?: string;
  limit?: number;
  allowWeekends?: boolean;
}): Promise<
  | { ok: true; slots: CalendarSlot[]; timeZone: string }
  | { ok: false; error: string }
> {
  const { timeZone, workingHours } = await loadTenantSchedule(params.tenantId);
  const now = new Date();
  const rangeEnd = new Date(now.getTime() + LOOKAHEAD_DAYS * 24 * 60 * 60 * 1000);
  const busy = await loadReosBusyIntervals(params.tenantId, now, rangeEnd);
  const kind = params.allowWeekends ? "showing" : "consult";

  return generateConsultSlots({
    preference: params.preference ?? "any",
    day: params.day,
    limit: params.limit,
    timeZone,
    busy,
    now,
    windowsFor: (weekday) => bookingWindowsFor(workingHours, weekday, kind),
  });
}

function withinBookingHours(
  start: Date,
  timeZone: string,
  workingHours: WorkingHours,
  kind: "consult" | "showing",
): boolean {
  const parts = zonedParts(start, timeZone);
  const startMinutes = parts.hour * 60 + parts.minute;
  const endMinutes = startMinutes + CONSULT_MINUTES;
  return bookingWindowsFor(workingHours, parts.weekday, kind).some(
    (win) =>
      startMinutes >= win.startMinute &&
      endMinutes <= win.endMinute &&
      (startMinutes - win.startMinute) % SLOT_STEP_MINUTES === 0,
  );
}

export type ResolveStartResult =
  | { ok: true; start: Date; end: Date }
  | { ok: false; error: string; openTimes: CalendarSlot[] };

/** Validate a requested start against real open slots; on failure, return open times that day. */
export async function resolveBookableStart(params: {
  tenantId: string;
  start: string;
  /** Day the lead picked ("saturday", "tomorrow", "2026-10-03") when start is only a time. */
  day?: string;
  allowWeekends?: boolean;
}): Promise<ResolveStartResult> {
  const { timeZone, workingHours } = await loadTenantSchedule(params.tenantId);
  const now = new Date();
  const allowWeekends = params.allowWeekends ?? false;
  const kind = allowWeekends ? "showing" : "consult";
  const start = parseRequestedStart(params.start, timeZone, now, params.day);

  const openTimesFor = async (day?: string) => {
    const result = await getAvailableReosConsultSlots({
      tenantId: params.tenantId,
      preference: "any",
      day,
      limit: 4,
      allowWeekends,
    });
    return result.ok ? result.slots : [];
  };

  if (!start) {
    return {
      ok: false,
      error:
        "Could not tell which day and time to book. Call book_appointment again with start set to the exact label of the slot they chose (it includes the date), or pass day as well.",
      openTimes: await openTimesFor(),
    };
  }

  const parts = zonedParts(start, timeZone);
  const dayKey = `${parts.year}-${String(parts.month).padStart(2, "0")}-${String(parts.day).padStart(2, "0")}`;
  const end = new Date(start.getTime() + CONSULT_MINUTES * 60 * 1000);

  const invalid =
    isBookableStart(start, timeZone, now) ??
    (start.getTime() < now.getTime() + 60 * 60 * 1000 ? "That time is too soon." : null) ??
    (!withinBookingHours(start, timeZone, workingHours, kind)
      ? bookingWindowsFor(workingHours, parts.weekday, kind).length === 0
        ? kind === "consult"
          ? `The team does not take consults on ${parts.weekday}. If this is a private showing of a property, call book_appointment again with kind "showing".`
          : `The team does not take showings on ${parts.weekday}.`
        : `${formatSlotLabel(start.toISOString(), timeZone)} is outside working hours.`
      : null);

  if (!invalid) {
    const busy = await loadReosBusyIntervals(
      params.tenantId,
      now,
      new Date(now.getTime() + LOOKAHEAD_DAYS * 24 * 60 * 60 * 1000),
    );
    if (!overlapsBusy(start.getTime(), end.getTime(), busy)) {
      return { ok: true, start, end };
    }
  }

  const openTimes = (await openTimesFor(dayKey))
    .map((slot) => ({ slot, distance: Math.abs(new Date(slot.start).getTime() - start.getTime()) }))
    .sort((a, b) => a.distance - b.distance)
    .slice(0, 4)
    .map(({ slot }) => slot)
    .sort((a, b) => a.start.localeCompare(b.start));
  return {
    ok: false,
    error: `${invalid ?? `${formatSlotLabel(start.toISOString(), timeZone)} is already taken.`} Offer the open times listed (same day) instead.`,
    openTimes: openTimes.length > 0 ? openTimes : await openTimesFor(),
  };
}

export type BookReosConsultResult =
  | {
      ok: true;
      appointmentId: string;
      contactId: string;
      start: string;
      end: string;
      label: string;
      inviteSent: boolean;
      attendeeEmail: string | null;
      confirmation: string;
    }
  | { ok: false; error: string };

/**
 * Persist a Concierge consult on the REOS calendar, then update CRM.
 * Does not call Google Calendar.
 */
export async function bookReosConsultSlot(params: {
  tenantId: string;
  contactId?: string | null;
  start: string;
  end?: string;
  attendeeEmail?: string | null;
  leadName?: string | null;
  summary?: string | null;
}): Promise<BookReosConsultResult> {
  const db = getSupabaseAdmin();
  if (!db) {
    return { ok: false, error: "Calendar service is unavailable." };
  }

  const timeZone = await loadTenantTimezone(params.tenantId);
  const start = new Date(params.start);
  const bookError = isBookableStart(start, timeZone);
  if (bookError) return { ok: false, error: bookError };

  const end = params.end
    ? new Date(params.end)
    : new Date(start.getTime() + CONSULT_MINUTES * 60 * 1000);
  if (Number.isNaN(end.getTime()) || end.getTime() <= start.getTime()) {
    return { ok: false, error: "Invalid end time." };
  }

  const now = new Date();
  const rangeEnd = new Date(now.getTime() + LOOKAHEAD_DAYS * 24 * 60 * 60 * 1000);
  const busy = await loadReosBusyIntervals(params.tenantId, now, rangeEnd);
  if (overlapsBusy(start.getTime(), end.getTime(), busy)) {
    return {
      ok: false,
      error: "That time is no longer available. Pick another slot from get_available_slots.",
    };
  }

  if (!params.contactId) {
    return { ok: false, error: "Missing contact for calendar booking." };
  }

  let { data: contact, error: contactLoadError } = await db
    .from("contacts")
    .select("id, tenant_id, first_name, last_name, record_type, email, assigned_agent_id")
    .eq("id", params.contactId)
    .eq("tenant_id", params.tenantId)
    .maybeSingle();

  if (contactLoadError && /assigned_agent_id|schema cache|column/i.test(contactLoadError.message)) {
    ({ data: contact } = await db
      .from("contacts")
      .select("id, tenant_id, first_name, last_name, record_type, email")
      .eq("id", params.contactId)
      .eq("tenant_id", params.tenantId)
      .maybeSingle());
  }

  if (!contact) {
    return { ok: false, error: "Contact was not found for this workspace." };
  }

  const leadName =
    params.leadName?.trim() ||
    [contact.first_name?.trim(), contact.last_name?.trim()].filter(Boolean).join(" ") ||
    null;

  const title =
    params.summary?.trim() ||
    `Consult${leadName ? ` - ${leadName}` : ""}`;

  const email =
    params.attendeeEmail?.trim().toLowerCase() ||
    contact.email?.trim().toLowerCase() ||
    null;
  const startIso = start.toISOString();
  const endIso = end.toISOString();
  const label = formatSlotLabel(startIso, timeZone);

  const relatedEntityType =
    contact.record_type === "contact" ? "contact" : "lead";

  const payload = {
    tenant_id: params.tenantId,
    contact_id: contact.id,
    activity_type: "appointment" as const,
    title,
    body: [
      "Booked via REOS Concierge.",
      label,
      email ? `Attendee: ${email}` : null,
    ]
      .filter(Boolean)
      .join("\n"),
    occurred_at: startIso,
    ends_at: endIso,
    source: "concierge",
    related_entity_type: relatedEntityType,
    related_entity_id: contact.id,
  };

  let { data: activity, error } = await db
    .from("contact_activities")
    .insert(payload)
    .select("id")
    .single();

  if (error && /ends_at|source|schema cache|column/i.test(error.message)) {
    const {
      ends_at: _e,
      source: _s,
      ...withoutTiming
    } = payload;
    ({ data: activity, error } = await db
      .from("contact_activities")
      .insert({
        ...withoutTiming,
        // Preserve start time even without ends_at column.
        occurred_at: startIso,
      })
      .select("id")
      .single());
  }

  if (error && /related_entity|schema cache|column/i.test(error.message)) {
    const {
      related_entity_type: _t,
      related_entity_id: _i,
      ...withoutRelated
    } = payload;
    ({ data: activity, error } = await db
      .from("contact_activities")
      .insert(withoutRelated)
      .select("id")
      .single());
  }

  if (error || !activity?.id) {
    console.error("REOS consult appointment insert failed:", error?.message);
    return { ok: false, error: "Could not create the appointment." };
  }

  const survivor = await markConsultBooked(contact.id, {
    email,
    skipAppointmentActivityLog: true,
  });
  if (!survivor) {
    // Appointment row exists; CRM flag failed — still report the booking so the
    // lead is not told to retry and create a duplicate.
    console.error("markConsultBooked failed after REOS appointment", activity.id);
  }

  const contactId = survivor ?? contact.id;
  const agentUserId = await resolveAssignedAgentUserId({
    tenantId: params.tenantId,
    contactId,
  });

  const invite = await sendAppointmentInvites({
    tenantId: params.tenantId,
    appointmentId: activity.id,
    summary: title,
    label,
    start,
    end,
    lead:
      email && isValidEmailAddress(email)
        ? { email, name: leadName }
        : null,
    agentUserId,
  });

  if (invite.errors.length > 0) {
    console.warn("Consult invite issues:", invite.errors.join("; "));
  }

  const confirmationParts = [`Booked ${label} on the REOS calendar.`];
  if (invite.inviteSent) {
    if (invite.leadSent && invite.agentSent) {
      confirmationParts.push("Calendar invites were emailed to the lead and assigned agent.");
    } else if (invite.leadSent) {
      confirmationParts.push("A calendar invite was emailed to the lead.");
    } else if (invite.agentSent) {
      confirmationParts.push("A calendar invite was emailed to the assigned agent.");
    }
  } else if (email) {
    confirmationParts.push(`We have ${email} on file.`);
  }

  return {
    ok: true,
    appointmentId: activity.id,
    contactId,
    start: startIso,
    end: endIso,
    label,
    inviteSent: invite.inviteSent,
    attendeeEmail: email,
    confirmation: confirmationParts.join(" "),
  };
}
