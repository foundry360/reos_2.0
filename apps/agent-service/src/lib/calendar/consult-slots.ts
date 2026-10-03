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

const NOON_MINUTE = 12 * 60;

const DEFAULT_DAY_WINDOWS = [morningWindow(), afternoonWindow()].map((win) => ({
  startMinute: win.startHour * 60,
  endMinute: win.endHour * 60,
}));

/** Morning = before noon, afternoon = noon onward. */
function clipToPreference(
  win: { startMinute: number; endMinute: number },
  preference: SlotPreference,
): Array<{ startMinute: number; endMinute: number }> {
  if (preference === "any") return [win];
  const clipped =
    preference === "morning"
      ? { startMinute: win.startMinute, endMinute: Math.min(win.endMinute, NOON_MINUTE) }
      : { startMinute: Math.max(win.startMinute, NOON_MINUTE), endMinute: win.endMinute };
  return clipped.endMinute > clipped.startMinute ? [clipped] : [];
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
  if (raw === "today") return dayKey(zonedParts(now, timeZone));
  if (raw === "tomorrow") {
    return dayKey(zonedParts(new Date(now.getTime() + 24 * 60 * 60 * 1000), timeZone));
  }

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

const MONTHS: Record<string, number> = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
};

/** "2026-10-03", "Oct 3", "Sat, Oct 3, 2026", "saturday", "tomorrow" → "YYYY-MM-DD". */
function resolveDateKey(text: string, timeZone: string, now: Date): string | null {
  const t = text.toLowerCase();
  const iso = t.match(/\b(\d{4})-(\d{2})-(\d{2})(?!\d)/);
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;

  const named = t.match(
    /\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+(\d{1,2})(?:st|nd|rd|th)?\b(?:,?\s+(\d{4})\b)?/,
  );
  if (named) {
    const month = MONTHS[named[1]];
    const day = Number(named[2]);
    const today = zonedParts(now, timeZone);
    let year = named[3] ? Number(named[3]) : today.year;
    if (!named[3] && (month < today.month || (month === today.month && day < today.day))) {
      year += 1;
    }
    return `${year}-${pad2(month)}-${pad2(day)}`;
  }

  if (/\btoday\b/.test(t)) return dayKey(zonedParts(now, timeZone));
  if (/\btomorrow\b/.test(t)) {
    return dayKey(zonedParts(new Date(now.getTime() + 24 * 60 * 60 * 1000), timeZone));
  }

  const weekday = t.match(
    /\b(?:next\s+)?(sun|mon|tue|tues|wed|thu|thur|fri|sat)(?:day|sday|nesday|rsday|urday)?\b/,
  );
  return weekday ? resolvePreferredDay(weekday[1], timeZone, now) : null;
}

/** "11am", "11:30 AM", "12 pm", "14:00" → hour/minute. */
function parseTimeOfDay(text: string): { hour: number; minute: number } | null {
  const t = text.toLowerCase();
  const ampm = t.match(/\b(\d{1,2})(?::(\d{2}))?\s*([ap])\.?m\.?\b/);
  if (ampm) {
    const hour12 = Number(ampm[1]);
    const minute = ampm[2] ? Number(ampm[2]) : 0;
    if (hour12 < 1 || hour12 > 12 || minute > 59) return null;
    return { hour: (hour12 % 12) + (ampm[3] === "p" ? 12 : 0), minute };
  }
  if (/\bnoon\b/.test(t)) return { hour: 12, minute: 0 };
  const h24 = t.match(/(?:^|[^\d])([01]?\d|2[0-3]):([0-5]\d)(?![\d])/);
  return h24 ? { hour: Number(h24[1]), minute: Number(h24[2]) } : null;
}

/**
 * Turn whatever the model passes as a start into an instant in the workspace time zone:
 * an ISO instant, "2026-10-03 11:00", a slot label ("Sat, Oct 3, 2026, 11:00 AM EDT"),
 * "Saturday 11am", or a bare time ("11am") with the date taken from dayHint.
 */
export function parseRequestedStart(
  input: string,
  timeZone: string,
  now: Date = new Date(),
  dayHint?: string,
): Date | null {
  const raw = input.trim();
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})$/i.test(raw)) {
    const date = new Date(raw);
    return Number.isNaN(date.getTime()) ? null : date;
  }

  const time = parseTimeOfDay(raw.replace(/\b\d{4}-\d{2}-\d{2}T?/, " "));
  const dateKey =
    resolveDateKey(raw, timeZone, now) ?? (dayHint ? resolveDateKey(dayHint, timeZone, now) : null);
  if (!time || !dateKey) return null;

  const [year, month, day] = dateKey.split("-").map(Number);
  return dateInTimeZone(year, month, day, time.hour, time.minute, timeZone);
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
  /** Showings happen on weekends; consults stay Monday–Friday. Ignored when windowsFor is set. */
  allowWeekends?: boolean;
  /** Workspace working hours: bookable minute-of-day windows for a weekday ("Mon"). */
  windowsFor?: (weekday: string) => Array<{ startMinute: number; endMinute: number }>;
}):
  | { ok: true; slots: CalendarSlot[]; timeZone: string }
  | { ok: false; error: string } {
  const preference = params.preference;
  const timeZone = params.timeZone || DEFAULT_TIME_ZONE;
  const now = params.now ?? new Date();
  const preferredDay = resolvePreferredDay(params.day, timeZone, now);
  // For a specific day return every open time, so a time the lead names is never
  // wrongly reported as taken just because it fell outside a short list.
  const limit = preferredDay ? 48 : Math.min(Math.max(params.limit ?? 3, 1), 5);
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

    const dayWindows = params.windowsFor
      ? params.windowsFor(parts.weekday)
      : isWeekend(parts.weekday) && !params.allowWeekends
        ? []
        : DEFAULT_DAY_WINDOWS;
    const windows = dayWindows.flatMap((win) => clipToPreference(win, preference));

    for (const win of windows) {
      for (
        let minuteOfDay = win.startMinute;
        minuteOfDay + CONSULT_MINUTES <= win.endMinute;
        minuteOfDay += SLOT_STEP_MINUTES
      ) {
        if ((takenByDay.get(key) ?? 0) >= perDayCap || slots.length >= limit) break;

        const start = dateInTimeZone(
          parts.year,
          parts.month,
          parts.day,
          Math.floor(minuteOfDay / 60),
          minuteOfDay % 60,
          timeZone,
        );
        const end = new Date(start.getTime() + CONSULT_MINUTES * 60 * 1000);
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
      if ((takenByDay.get(key) ?? 0) >= perDayCap || slots.length >= limit) break;
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
