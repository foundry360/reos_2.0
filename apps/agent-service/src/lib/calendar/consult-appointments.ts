import { getSupabaseAdmin } from "@/lib/supabase/admin";
import { markConsultBooked } from "@/lib/db/contacts";
import {
  CONSULT_MINUTES,
  DEFAULT_TIME_ZONE,
  LOOKAHEAD_DAYS,
  formatSlotLabel,
  isBookableStart,
  overlapsBusy,
  type BusyInterval,
  type CalendarSlot,
  type SlotPreference,
} from "@/lib/calendar/consult-slots";
import {
  checkRequestedStart,
  findOpenSlots,
  lookaheadEnd,
  type ResolveStartResult,
} from "@/lib/calendar/calendar-core";
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

/** This lead's appointments from now on, soonest first. */
export async function loadContactUpcomingAppointments(
  tenantId: string,
  contactId: string,
  now: Date,
): Promise<Array<{ id: string; start: string; end: string; title: string | null }>> {
  const db = getSupabaseAdmin();
  if (!db) return [];
  const { data, error } = await db
    .from("contact_activities")
    .select("id, occurred_at, ends_at, title")
    .eq("tenant_id", tenantId)
    .eq("contact_id", contactId)
    .in("activity_type", ["appointment", "meeting"])
    .gte("occurred_at", now.toISOString())
    .order("occurred_at", { ascending: true })
    .limit(5);
  if (error) {
    console.warn("Upcoming appointments lookup failed:", error.message);
    return [];
  }
  return (data ?? []).map((row) => ({
    id: row.id,
    start: row.occurred_at,
    end:
      row.ends_at ??
      new Date(new Date(row.occurred_at).getTime() + APPOINTMENT_DEFAULT_MINUTES * 60 * 1000).toISOString(),
    title: row.title ?? null,
  }));
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
  const schedule = await loadTenantSchedule(params.tenantId);
  const now = new Date();
  const busy = await loadReosBusyIntervals(params.tenantId, now, lookaheadEnd(now));
  return findOpenSlots({
    schedule,
    busy,
    now,
    kind: params.allowWeekends ? "showing" : "consult",
    preference: params.preference ?? "any",
    day: params.day,
    limit: params.limit,
  });
}

export type { ResolveStartResult };

/** Validate a requested start against real open slots; on failure, return open times that day. */
export async function resolveBookableStart(params: {
  tenantId: string;
  start: string;
  /** Day the lead picked ("saturday", "tomorrow", "2026-10-03") when start is only a time. */
  day?: string;
  allowWeekends?: boolean;
}): Promise<ResolveStartResult> {
  const schedule = await loadTenantSchedule(params.tenantId);
  const now = new Date();
  const busy = await loadReosBusyIntervals(params.tenantId, now, lookaheadEnd(now));
  return checkRequestedStart({
    schedule,
    busy,
    now,
    kind: params.allowWeekends ? "showing" : "consult",
    start: params.start,
    day: params.day,
  });
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
      leadInviteSent: boolean;
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
    leadInviteSent: invite.leadSent,
    attendeeEmail: email,
    confirmation: confirmationParts.join(" "),
  };
}

/**
 * Move an existing appointment to a new time in place (same row, same invite uid),
 * then re-send the invite with a higher SEQUENCE so calendars update the event.
 */
export async function rescheduleReosAppointment(params: {
  tenantId: string;
  appointmentId: string;
  start: string;
  end: string;
  attendeeEmail?: string | null;
  leadName?: string | null;
}): Promise<BookReosConsultResult> {
  const db = getSupabaseAdmin();
  if (!db) return { ok: false, error: "Calendar service is unavailable." };

  const { data: appt, error: loadError } = await db
    .from("contact_activities")
    .select("id, contact_id, activity_type, title, body, occurred_at, ends_at, metadata")
    .eq("id", params.appointmentId)
    .eq("tenant_id", params.tenantId)
    .maybeSingle();
  if (loadError || !appt) {
    return { ok: false, error: loadError?.message ?? "Appointment was not found." };
  }
  if (appt.activity_type !== "appointment" && appt.activity_type !== "meeting") {
    return { ok: false, error: "That record is not an appointment." };
  }

  const timeZone = await loadTenantTimezone(params.tenantId);
  const start = new Date(params.start);
  const end = new Date(params.end);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || end <= start) {
    return { ok: false, error: "Invalid time." };
  }

  const oldStart = new Date(appt.occurred_at).getTime();
  const oldEnd = appt.ends_at
    ? new Date(appt.ends_at).getTime()
    : oldStart + APPOINTMENT_DEFAULT_MINUTES * 60 * 1000;
  const now = new Date();
  const busy = (await loadReosBusyIntervals(params.tenantId, now, lookaheadEnd(now))).filter(
    (b) => !(b.start === oldStart && b.end === oldEnd),
  );
  if (overlapsBusy(start.getTime(), end.getTime(), busy)) {
    return { ok: false, error: "That time is no longer available." };
  }

  const startIso = start.toISOString();
  const endIso = end.toISOString();
  const label = formatSlotLabel(startIso, timeZone);
  const previousLabel = formatSlotLabel(new Date(oldStart).toISOString(), timeZone);
  const prior =
    appt.metadata && typeof appt.metadata === "object" && !Array.isArray(appt.metadata)
      ? (appt.metadata as Record<string, unknown>)
      : {};
  const sequence = (typeof prior.invite_sequence === "number" ? prior.invite_sequence : 0) + 1;
  const history = Array.isArray(prior.reschedules) ? prior.reschedules : [];

  const { error: updateError } = await db
    .from("contact_activities")
    .update({
      occurred_at: startIso,
      ends_at: endIso,
      body: [appt.body?.trim(), `Rescheduled from ${previousLabel} to ${label}.`].filter(Boolean).join("\n"),
      metadata: {
        ...prior,
        invite_sequence: sequence,
        reschedules: [...history, { from: appt.occurred_at, to: startIso, at: now.toISOString() }],
      },
    })
    .eq("id", appt.id)
    .eq("tenant_id", params.tenantId);
  if (updateError) {
    console.error("Reschedule update failed:", updateError.message);
    return { ok: false, error: "Could not move the appointment." };
  }

  const contactId = appt.contact_id as string;
  const { data: contact } = await db
    .from("contacts")
    .select("first_name, last_name, email")
    .eq("id", contactId)
    .maybeSingle();
  const leadName =
    params.leadName?.trim() ||
    [contact?.first_name?.trim(), contact?.last_name?.trim()].filter(Boolean).join(" ") ||
    null;
  const email = params.attendeeEmail?.trim().toLowerCase() || contact?.email?.trim().toLowerCase() || null;
  const title = appt.title?.trim() || `Consult${leadName ? ` - ${leadName}` : ""}`;

  const invite = await sendAppointmentInvites({
    tenantId: params.tenantId,
    appointmentId: appt.id,
    summary: title,
    label,
    start,
    end,
    lead: email && isValidEmailAddress(email) ? { email, name: leadName } : null,
    agentUserId: await resolveAssignedAgentUserId({ tenantId: params.tenantId, contactId }),
    update: { sequence, previousLabel },
  });
  if (invite.errors.length > 0) console.warn("Reschedule invite issues:", invite.errors.join("; "));

  return {
    ok: true,
    appointmentId: appt.id,
    contactId,
    start: startIso,
    end: endIso,
    label,
    inviteSent: invite.inviteSent,
    leadInviteSent: invite.leadSent,
    attendeeEmail: email,
    confirmation: `Moved from ${previousLabel} to ${label}.`,
  };
}
