/**
 * Pure availability and booking checks. The live calendar (DB-backed busy times) and the
 * agent eval sandbox (in-memory busy times) both run through these.
 */
import {
  CONSULT_MINUTES,
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
import { bookingWindowsFor, toMinutes, type WorkingHours } from "@/lib/calendar/working-hours";

export type AppointmentKind = "consult" | "showing";

export interface Schedule {
  timeZone: string;
  workingHours: WorkingHours;
}

export type FindSlotsResult =
  | { ok: true; slots: CalendarSlot[]; timeZone: string }
  | { ok: false; error: string };

export type ResolveStartResult =
  | { ok: true; start: Date; end: Date }
  | { ok: false; error: string; openTimes: CalendarSlot[] };

function clipWindows(
  windows: Array<{ startMinute: number; endMinute: number }>,
  after: number | null,
  before: number | null,
) {
  return windows
    .map((win) => ({
      startMinute: after == null ? win.startMinute : Math.max(win.startMinute, after),
      endMinute: before == null ? win.endMinute : Math.min(win.endMinute, before),
    }))
    .filter((win) => win.endMinute - win.startMinute >= CONSULT_MINUTES);
}

function parseClock(value: string | undefined): number | null {
  if (!value?.trim()) return null;
  const minutes = toMinutes(value.trim());
  return Number.isFinite(minutes) ? minutes : null;
}

export function findOpenSlots(params: {
  schedule: Schedule;
  busy: BusyInterval[];
  now: Date;
  kind: AppointmentKind;
  preference?: SlotPreference;
  day?: string;
  /** Earliest local start, "HH:MM". */
  after?: string;
  /** Latest local end, "HH:MM". */
  before?: string;
  limit?: number;
}): FindSlotsResult {
  const after = parseClock(params.after);
  const before = parseClock(params.before);
  return generateConsultSlots({
    preference: params.preference ?? "any",
    day: params.day,
    limit: params.limit,
    timeZone: params.schedule.timeZone,
    busy: params.busy,
    now: params.now,
    windowsFor: (weekday) =>
      clipWindows(bookingWindowsFor(params.schedule.workingHours, weekday, params.kind), after, before),
  });
}

export function withinBookingHours(
  start: Date,
  schedule: Schedule,
  kind: AppointmentKind,
): boolean {
  const parts = zonedParts(start, schedule.timeZone);
  const startMinutes = parts.hour * 60 + parts.minute;
  const endMinutes = startMinutes + CONSULT_MINUTES;
  return bookingWindowsFor(schedule.workingHours, parts.weekday, kind).some(
    (win) =>
      startMinutes >= win.startMinute &&
      endMinutes <= win.endMinute &&
      (startMinutes - win.startMinute) % SLOT_STEP_MINUTES === 0,
  );
}

/** Validate a requested start against real open slots; on failure, return nearby open times that day. */
export function checkRequestedStart(params: {
  schedule: Schedule;
  busy: BusyInterval[];
  now: Date;
  kind: AppointmentKind;
  start: string;
  day?: string;
}): ResolveStartResult {
  const { schedule, busy, now, kind } = params;
  const { timeZone, workingHours } = schedule;
  const start = parseRequestedStart(params.start, timeZone, now, params.day);

  const openTimesFor = (day?: string) => {
    const result = findOpenSlots({ schedule, busy, now, kind, day, limit: 4 });
    return result.ok ? result.slots : [];
  };

  if (!start) {
    return {
      ok: false,
      error:
        "Could not tell which day and time to book. Pass start as the exact ISO start of an offered time, or \"YYYY-MM-DD HH:MM\" in the workspace time zone.",
      openTimes: openTimesFor(),
    };
  }

  const parts = zonedParts(start, timeZone);
  const dayKey = `${parts.year}-${String(parts.month).padStart(2, "0")}-${String(parts.day).padStart(2, "0")}`;
  const end = new Date(start.getTime() + CONSULT_MINUTES * 60 * 1000);

  const invalid =
    isBookableStart(start, timeZone, now) ??
    (start.getTime() < now.getTime() + 60 * 60 * 1000 ? "That time is too soon." : null) ??
    (!withinBookingHours(start, schedule, kind)
      ? bookingWindowsFor(workingHours, parts.weekday, kind).length === 0
        ? kind === "consult"
          ? `The team does not take consults on ${parts.weekday}. If this is a private showing of a property, use kind "showing".`
          : `The team does not take showings on ${parts.weekday}.`
        : `${formatSlotLabel(start.toISOString(), timeZone)} is outside working hours.`
      : null);

  if (!invalid && !overlapsBusy(start.getTime(), end.getTime(), busy)) {
    return { ok: true, start, end };
  }

  const nearby = openTimesFor(dayKey)
    .map((slot) => ({ slot, distance: Math.abs(new Date(slot.start).getTime() - start.getTime()) }))
    .sort((a, b) => a.distance - b.distance)
    .slice(0, 4)
    .map(({ slot }) => slot)
    .sort((a, b) => a.start.localeCompare(b.start));
  return {
    ok: false,
    error: `${invalid ?? `${formatSlotLabel(start.toISOString(), timeZone)} is already taken.`} Offer the open times listed instead.`,
    openTimes: nearby.length > 0 ? nearby : openTimesFor(),
  };
}

export function lookaheadEnd(now: Date): Date {
  return new Date(now.getTime() + LOOKAHEAD_DAYS * 24 * 60 * 60 * 1000);
}
