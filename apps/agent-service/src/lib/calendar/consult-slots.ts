/**
 * Pure helpers for REOS consult slot generation (no Google dependency).
 * Shared by availability lookup and unit tests.
 */

export type SlotPreference = "morning" | "afternoon" | "any";

export interface CalendarSlot {
  start: string;
  end: string;
  label: string;
}

export interface BusyInterval {
  start: number;
  end: number;
}

export const CONSULT_MINUTES = 30;
export const SLOT_STEP_MINUTES = 30;
export const LOOKAHEAD_DAYS = 14;
export const DEFAULT_TIME_ZONE = "America/New_York";

const WEEKDAYS: Record<string, number> = {
  sun: 0,
  sunday: 0,
  mon: 1,
  monday: 1,
  tue: 2,
  tues: 2,
  tuesday: 2,
  wed: 3,
  wednesday: 3,
  thu: 4,
  thur: 4,
  thursday: 4,
  fri: 5,
  friday: 5,
  sat: 6,
  saturday: 6,
};

export function morningWindow(): { startHour: number; endHour: number } {
  return { startHour: 9, endHour: 12 };
}

export function afternoonWindow(): { startHour: number; endHour: number } {
  return { startHour: 13, endHour: 17 };
}

export function zonedParts(date: Date, timeZone: string) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    weekday: "short",
  }).formatToParts(date);
  const get = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((p) => p.type === type)?.value ?? "";
  return {
    year: Number(get("year")),
    month: Number(get("month")),
    day: Number(get("day")),
    hour: Number(get("hour") === "24" ? "0" : get("hour")),
    minute: Number(get("minute")),
    weekday: get("weekday"),
  };
}

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

export function formatSlotLabel(startIso: string, timeZone: string): string {
  const start = new Date(startIso);
  return new Intl.DateTimeFormat("en-US", {
    timeZone,
    weekday: "short",
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
  }).format(start);
}

/** Build a Date for a local wall time in the given IANA time zone. */
export function dateInTimeZone(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  timeZone: string,
): Date {
  let guess = new Date(Date.UTC(year, month - 1, day, hour, minute, 0));
  for (let i = 0; i < 3; i++) {
    const parts = zonedParts(guess, timeZone);
    const asUtc = Date.UTC(
      parts.year,
      parts.month - 1,
      parts.day,
      parts.hour,
      parts.minute,
      0,
    );
    const desired = Date.UTC(year, month - 1, day, hour, minute, 0);
    guess = new Date(guess.getTime() + (desired - asUtc));
  }
  return guess;
}

function isWeekend(weekday: string): boolean {
  return weekday === "Sat" || weekday === "Sun";
}

export function overlapsBusy(
  startMs: number,
  endMs: number,
  busy: BusyInterval[],
): boolean {
  return busy.some((b) => startMs < b.end && endMs > b.start);
}

function dayKey(parts: { year: number; month: number; day: number }): string {
  return `${parts.year}-${pad2(parts.month)}-${pad2(parts.day)}`;
}

/**
 * Resolve a day hint like "wednesday", "wed", "2026-09-03" to the next matching
 * calendar day within LOOKAHEAD_DAYS.
 */
export function resolvePreferredDay(
  dayHint: string | undefined,
  timeZone: string,
  now: Date = new Date(),
): string | null {
  if (!dayHint?.trim()) return null;
  const raw = dayHint.trim().toLowerCase().replace(/^next\s+/, "");

  const iso = raw.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;

  const want = WEEKDAYS[raw];
  if (want === undefined) return null;

  const weekdayIndex: Record<string, number> = {
    Sun: 0,
    Mon: 1,
    Tue: 2,
    Wed: 3,
    Thu: 4,
    Fri: 5,
    Sat: 6,
  };

  for (let offset = 0; offset < LOOKAHEAD_DAYS; offset++) {
    const probe = new Date(now.getTime() + offset * 24 * 60 * 60 * 1000);
    const parts = zonedParts(probe, timeZone);
    if (weekdayIndex[parts.weekday] === want) {
      return dayKey(parts);
    }
  }
  return null;
}

export function isBookableStart(
  start: Date,
  timeZone: string,
  now: Date = new Date(),
): string | null {
  const nowMs = now.getTime();
  if (Number.isNaN(start.getTime())) return "Invalid start time.";
  if (start.getTime() < nowMs - 5 * 60 * 1000) {
    return "That time is in the past. Pick a future slot from get_available_slots.";
  }
  if (start.getTime() > nowMs + LOOKAHEAD_DAYS * 24 * 60 * 60 * 1000) {
    return "That time is too far out. Pick a slot from get_available_slots.";
  }
  const year = zonedParts(start, timeZone).year;
  const currentYear = zonedParts(now, timeZone).year;
  if (year < currentYear || year > currentYear + 1) {
    return `Refusing to book year ${year}. Use an exact start value from get_available_slots.`;
  }
  return null;
}

/** Generate open consult slots given busy intervals (REOS or any source). */
export function generateConsultSlots(params: {
  preference: SlotPreference;
  day?: string;
  limit?: number;
  timeZone: string;
  busy: BusyInterval[];
  now?: Date;
}):
  | { ok: true; slots: CalendarSlot[]; timeZone: string }
  | { ok: false; error: string } {
  const preference = params.preference;
  const limit = Math.min(Math.max(params.limit ?? 3, 1), 5);
  const timeZone = params.timeZone || DEFAULT_TIME_ZONE;
  const now = params.now ?? new Date();
  const preferredDay = resolvePreferredDay(params.day, timeZone, now);
  const timeMin = now;
  const busy = params.busy;

  const slots: CalendarSlot[] = [];
  const earliest = now.getTime() + 60 * 60 * 1000;
  const perDayCap = preferredDay ? limit : 1;
  const takenByDay = new Map<string, number>();

  for (
    let dayOffset = 0;
    dayOffset < LOOKAHEAD_DAYS && slots.length < limit;
    dayOffset++
  ) {
    const probe = new Date(timeMin.getTime() + dayOffset * 24 * 60 * 60 * 1000);
    const parts = zonedParts(probe, timeZone);
    const key = dayKey(parts);
    if (preferredDay && key !== preferredDay) continue;
    if (isWeekend(parts.weekday)) continue;

    const windows: Array<{ startHour: number; endHour: number }> = [];
    if (preference === "morning" || preference === "any") {
      windows.push(morningWindow());
    }
    if (preference === "afternoon" || preference === "any") {
      windows.push(afternoonWindow());
    }

    for (const win of windows) {
      for (let hour = win.startHour; hour < win.endHour; hour++) {
        for (let minute = 0; minute < 60; minute += SLOT_STEP_MINUTES) {
          if ((takenByDay.get(key) ?? 0) >= perDayCap) break;
          if (slots.length >= limit) break;

          const start = dateInTimeZone(
            parts.year,
            parts.month,
            parts.day,
            hour,
            minute,
            timeZone,
          );
          const end = new Date(start.getTime() + CONSULT_MINUTES * 60 * 1000);
          const endParts = zonedParts(end, timeZone);
          if (
            endParts.day !== parts.day ||
            endParts.hour > win.endHour ||
            (endParts.hour === win.endHour && endParts.minute > 0)
          ) {
            continue;
          }
          if (start.getTime() < earliest) continue;
          if (overlapsBusy(start.getTime(), end.getTime(), busy)) continue;
          if (parts.year < zonedParts(now, timeZone).year) continue;

          const startIso = start.toISOString();
          slots.push({
            start: startIso,
            end: end.toISOString(),
            label: formatSlotLabel(startIso, timeZone),
          });
          takenByDay.set(key, (takenByDay.get(key) ?? 0) + 1);
        }
        if ((takenByDay.get(key) ?? 0) >= perDayCap || slots.length >= limit) {
          break;
        }
      }
      if ((takenByDay.get(key) ?? 0) >= perDayCap || slots.length >= limit) {
        break;
      }
    }
  }

  if (slots.length === 0) {
    return {
      ok: false,
      error: preferredDay
        ? `No open consult slots on ${preferredDay} for that preference.`
        : "No open consult slots in the next two weeks for that preference.",
    };
  }

  return { ok: true, slots, timeZone };
}
