/**
 * Workspace working hours (tenants.working_hours). Pure helpers shared by the
 * calendar settings modal and AI slot generation / booking validation.
 */

export const WEEKDAY_KEYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"] as const;
export type WeekdayKey = (typeof WEEKDAY_KEYS)[number];

export const WEEKDAY_LABELS: Record<WeekdayKey, string> = {
  sun: "Sunday",
  mon: "Monday",
  tue: "Tuesday",
  wed: "Wednesday",
  thu: "Thursday",
  fri: "Friday",
  sat: "Saturday",
};

/** Local wall-clock range, "HH:MM" 24h. End may be "24:00". */
export interface TimeRange {
  start: string;
  end: string;
}

export interface WorkingHours {
  days: Record<WeekdayKey, TimeRange[]>;
  /** Let the AI book property showings on days off, using your usual hours. */
  showingsOnDaysOff: boolean;
}

export interface MinuteWindow {
  startMinute: number;
  endMinute: number;
}

const WEEKDAY_RANGES: TimeRange[] = [{ start: "09:00", end: "17:00" }];

export const DEFAULT_WORKING_HOURS: WorkingHours = {
  days: {
    sun: [],
    mon: WEEKDAY_RANGES,
    tue: WEEKDAY_RANGES,
    wed: WEEKDAY_RANGES,
    thu: WEEKDAY_RANGES,
    fri: WEEKDAY_RANGES,
    sat: [],
  },
  showingsOnDaysOff: true,
};

export const TIME_STEP_MINUTES = 30;

export function toMinutes(value: string): number | null {
  const match = /^(\d{1,2}):(\d{2})$/.exec(value.trim());
  if (!match) return null;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (minute > 59 || hour > 24 || (hour === 24 && minute !== 0)) return null;
  return hour * 60 + minute;
}

export function fromMinutes(total: number): string {
  const hour = Math.floor(total / 60);
  const minute = total % 60;
  return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
}

export function formatTimeOfDay(value: string): string {
  const total = toMinutes(value);
  if (total === null) return value;
  if (total === 24 * 60) return "12:00 AM (midnight)";
  const hour = Math.floor(total / 60);
  const minute = total % 60;
  const suffix = hour < 12 ? "AM" : "PM";
  const h12 = hour % 12 === 0 ? 12 : hour % 12;
  return `${h12}:${String(minute).padStart(2, "0")} ${suffix}`;
}

function cloneDefault(): WorkingHours {
  return {
    days: Object.fromEntries(
      WEEKDAY_KEYS.map((key) => [key, DEFAULT_WORKING_HOURS.days[key].map((r) => ({ ...r }))]),
    ) as Record<WeekdayKey, TimeRange[]>,
    showingsOnDaysOff: DEFAULT_WORKING_HOURS.showingsOnDaysOff,
  };
}

/** Returns an error message, or null when the hours are valid. */
export function validateWorkingHours(hours: WorkingHours): string | null {
  for (const key of WEEKDAY_KEYS) {
    const ranges = hours.days[key] ?? [];
    const sorted = ranges
      .map((r) => ({ start: toMinutes(r.start), end: toMinutes(r.end) }))
      .sort((a, b) => (a.start ?? 0) - (b.start ?? 0));
    for (let i = 0; i < sorted.length; i++) {
      const { start, end } = sorted[i];
      if (start === null || end === null) return `${WEEKDAY_LABELS[key]} has an invalid time.`;
      if (end <= start) return `${WEEKDAY_LABELS[key]}: end time must be after start time.`;
      if (i > 0 && start < (sorted[i - 1].end ?? 0)) {
        return `${WEEKDAY_LABELS[key]} has overlapping time ranges.`;
      }
    }
  }
  if (WEEKDAY_KEYS.every((key) => (hours.days[key] ?? []).length === 0)) {
    return "Pick at least one working day.";
  }
  return null;
}

/** Parse the stored jsonb; anything missing or invalid falls back to the defaults. */
export function normalizeWorkingHours(raw: unknown): WorkingHours {
  if (!raw || typeof raw !== "object") return cloneDefault();
  const input = raw as { days?: unknown; showingsOnDaysOff?: unknown };
  const days = (input.days && typeof input.days === "object" ? input.days : {}) as Record<
    string,
    unknown
  >;
  const hours: WorkingHours = {
    days: Object.fromEntries(
      WEEKDAY_KEYS.map((key) => {
        const list = Array.isArray(days[key]) ? (days[key] as unknown[]) : [];
        const ranges = list.flatMap((item) => {
          if (!item || typeof item !== "object") return [];
          const { start, end } = item as { start?: unknown; end?: unknown };
          return typeof start === "string" && typeof end === "string" ? [{ start, end }] : [];
        });
        ranges.sort((a, b) => (toMinutes(a.start) ?? 0) - (toMinutes(b.start) ?? 0));
        return [key, ranges];
      }),
    ) as Record<WeekdayKey, TimeRange[]>,
    showingsOnDaysOff:
      typeof input.showingsOnDaysOff === "boolean"
        ? input.showingsOnDaysOff
        : DEFAULT_WORKING_HOURS.showingsOnDaysOff,
  };
  return validateWorkingHours(hours) ? cloneDefault() : hours;
}

function toWindows(ranges: TimeRange[]): MinuteWindow[] {
  return ranges.flatMap((r) => {
    const startMinute = toMinutes(r.start);
    const endMinute = toMinutes(r.end);
    return startMinute === null || endMinute === null || endMinute <= startMinute
      ? []
      : [{ startMinute, endMinute }];
  });
}

/**
 * Bookable windows for a weekday ("Mon" / "monday" / "mon").
 * Showings on a day off borrow the hours of the first working weekday.
 */
export function bookingWindowsFor(
  hours: WorkingHours,
  weekday: string,
  kind: "consult" | "showing",
): MinuteWindow[] {
  const key = weekday.trim().toLowerCase().slice(0, 3) as WeekdayKey;
  const own = toWindows(hours.days[key] ?? []);
  if (own.length > 0 || kind !== "showing" || !hours.showingsOnDaysOff) return own;
  const fallbackOrder: WeekdayKey[] = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"];
  for (const day of fallbackOrder) {
    const borrowed = toWindows(hours.days[day] ?? []);
    if (borrowed.length > 0) return borrowed;
  }
  return [];
}

/** Short summary for the agent prompt, e.g. "Mon-Fri 9:00 AM-12:00 PM, 1:00 PM-5:00 PM". */
export function describeWorkingHours(hours: WorkingHours): string {
  const parts: string[] = [];
  const order: WeekdayKey[] = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"];
  const label = (r: TimeRange[]) =>
    r.map((x) => `${formatTimeOfDay(x.start)}-${formatTimeOfDay(x.end)}`).join(", ");
  let i = 0;
  while (i < order.length) {
    const ranges = hours.days[order[i]];
    let j = i;
    while (j + 1 < order.length && label(hours.days[order[j + 1]]) === label(ranges)) j++;
    if (ranges.length > 0) {
      const short = (k: WeekdayKey) => WEEKDAY_LABELS[k].slice(0, 3);
      const span = i === j ? short(order[i]) : `${short(order[i])}-${short(order[j])}`;
      parts.push(`${span} ${label(ranges)}`);
    }
    i = j + 1;
  }
  return parts.join("; ");
}
