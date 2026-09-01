const DAY_MS = 24 * 60 * 60 * 1000;

export function parseIsoDate(value: string): Date {
  const [y, m, d] = value.split("-").map(Number);
  return new Date(y, (m ?? 1) - 1, d ?? 1);
}

export function toIsoDate(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

export function startOfDay(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

export function endOfDay(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate(), 23, 59, 59, 999);
}

export function addDays(date: Date, days: number): Date {
  const next = new Date(date);
  next.setDate(next.getDate() + days);
  return next;
}

export function addMonths(date: Date, months: number): Date {
  return new Date(date.getFullYear(), date.getMonth() + months, date.getDate());
}

export function startOfWeek(date: Date): Date {
  const start = startOfDay(date);
  start.setDate(start.getDate() - start.getDay());
  return start;
}

export function endOfWeek(date: Date): Date {
  return endOfDay(addDays(startOfWeek(date), 6));
}

export function startOfMonth(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), 1);
}

export function endOfMonth(date: Date): Date {
  return endOfDay(new Date(date.getFullYear(), date.getMonth() + 1, 0));
}

export function sameDay(a: Date, b: Date): boolean {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}

export function isToday(date: Date): boolean {
  return sameDay(date, new Date());
}

export function getVisibleRange(view: string, anchor: Date): { start: Date; end: Date } {
  switch (view) {
    case "day":
      return { start: startOfDay(anchor), end: endOfDay(anchor) };
    case "week":
      return { start: startOfWeek(anchor), end: endOfWeek(anchor) };
    case "agenda":
      return { start: startOfDay(anchor), end: endOfDay(addDays(anchor, 30)) };
    case "month":
    default:
      return {
        start: startOfWeek(startOfMonth(anchor)),
        end: endOfWeek(endOfMonth(anchor)),
      };
  }
}

export function getMonthGridDays(anchor: Date): Date[] {
  const gridStart = startOfWeek(startOfMonth(anchor));
  return Array.from({ length: 42 }, (_, index) => addDays(gridStart, index));
}

export function getWeekDays(anchor: Date): Date[] {
  const weekStart = startOfWeek(anchor);
  return Array.from({ length: 7 }, (_, index) => addDays(weekStart, index));
}

export function formatMonthYear(date: Date): string {
  return new Intl.DateTimeFormat("en-US", { month: "long", year: "numeric" }).format(date);
}

export function formatShortWeekday(date: Date): string {
  return new Intl.DateTimeFormat("en-US", { weekday: "short" })
    .format(date)
    .replace(/\.$/, "");
}

export function formatShortMonthDay(date: Date): string {
  return new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric" }).format(date);
}

export function formatAgendaHeading(date: Date): string {
  if (isToday(date)) return "Today";
  const tomorrow = addDays(startOfDay(new Date()), 1);
  if (sameDay(date, tomorrow)) return "Tomorrow";
  return new Intl.DateTimeFormat("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
  })
    .format(date)
    .replace(/\b(\w{3})\./g, "$1");
}

export function formatTime(iso: string): string {
  return new Intl.DateTimeFormat("en-US", {
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(iso));
}

const longDateFormatter = new Intl.DateTimeFormat("en-US", {
  weekday: "short",
  month: "short",
  day: "numeric",
  year: "numeric",
});

export function formatCalendarEventDateLine(event: {
  start: string;
  end: string;
  allDay: boolean;
}): string {
  const start = new Date(event.start);
  const end = new Date(event.end);

  if (event.allDay && !sameDay(start, end)) {
    return `${longDateFormatter.format(start)} – ${longDateFormatter.format(end)}`;
  }

  return longDateFormatter.format(start);
}

export function formatCalendarEventTimeLine(event: {
  start: string;
  end: string;
  allDay: boolean;
}): string {
  if (event.allDay) return "All day";

  const start = new Date(event.start);
  const end = new Date(event.end);

  if (sameDay(start, end)) {
    return `${formatTime(event.start)} – ${formatTime(event.end)}`;
  }

  return `${formatTime(event.start)} – ${formatTime(event.end)}`;
}

export function eventOverlapsDay(eventStart: Date, eventEnd: Date, day: Date): boolean {
  const dayStart = startOfDay(day);
  const dayEnd = endOfDay(day);
  return eventStart <= dayEnd && eventEnd >= dayStart;
}

export function minutesFromMidnight(date: Date): number {
  return date.getHours() * 60 + date.getMinutes();
}

export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/** Day/week time grids: 12:00 AM through 11:00 PM (24 hour rows). */
export const CALENDAR_GRID_START_HOUR = 0;
export const CALENDAR_GRID_HOUR_COUNT = 24;
export const CALENDAR_GRID_SCROLL_TO_HOUR = 7;
export const CALENDAR_GRID_TOTAL_MINUTES = CALENDAR_GRID_HOUR_COUNT * 60;
export const CALENDAR_GRID_HOUR_HEIGHT = 48;

export function calendarGridHours(): number[] {
  return Array.from(
    { length: CALENDAR_GRID_HOUR_COUNT },
    (_, index) => CALENDAR_GRID_START_HOUR + index,
  );
}

export function calendarGridHeightPx(): number {
  return CALENDAR_GRID_HOUR_COUNT * CALENDAR_GRID_HOUR_HEIGHT;
}

export function calendarGridScrollTopPx(): number {
  return CALENDAR_GRID_SCROLL_TO_HOUR * CALENDAR_GRID_HOUR_HEIGHT;
}

export function layoutTimedEventOnGrid(
  clipStart: Date,
  clipEnd: Date,
): { topMin: number; heightMin: number } {
  const gridStartMin = CALENDAR_GRID_START_HOUR * 60;
  const startMin = minutesFromMidnight(clipStart);
  const endMin = minutesFromMidnight(clipEnd);
  const topMin = clamp(startMin - gridStartMin, 0, CALENDAR_GRID_TOTAL_MINUTES);
  const visibleEndMin = clamp(endMin - gridStartMin, topMin, CALENDAR_GRID_TOTAL_MINUTES);
  const heightMin = Math.max(visibleEndMin - topMin, 15);
  return { topMin, heightMin };
}

export function timedEventGridStyle(topMin: number, heightMin: number): {
  topPct: number;
  heightPct: number;
} {
  const topPct = (topMin / CALENDAR_GRID_TOTAL_MINUTES) * 100;
  const heightPct = (heightMin / CALENDAR_GRID_TOTAL_MINUTES) * 100;
  return {
    topPct,
    heightPct: clamp(heightPct, 2, 100 - topPct),
  };
}

export interface TimedOverlapSlot {
  id: string;
  startMin: number;
  endMin: number;
}

export interface TimedOverlapLayout {
  column: number;
  columnCount: number;
}

function timedEventsOverlapInTime(
  a: Pick<TimedOverlapSlot, "startMin" | "endMin">,
  b: Pick<TimedOverlapSlot, "startMin" | "endMin">,
): boolean {
  return a.startMin < b.endMin && b.startMin < a.endMin;
}

/** Assign overlap columns for concurrent events (cascade with moderate overlap). */
export function layoutTimedEventOverlaps<T extends TimedOverlapSlot>(
  items: T[],
): Array<T & TimedOverlapLayout> {
  if (items.length === 0) return [];

  const sorted = [...items].sort(
    (a, b) =>
      a.startMin - b.startMin ||
      b.endMin - b.startMin - (a.endMin - a.startMin) ||
      a.id.localeCompare(b.id),
  );

  const layouts: Array<T & { column: number; columnCount: number }> = [];

  for (const item of sorted) {
    const overlapping = layouts.filter((layout) => timedEventsOverlapInTime(item, layout));
    const usedColumns = new Set(overlapping.map((layout) => layout.column));
    let column = 0;
    while (usedColumns.has(column)) column++;

    const columnCount = Math.max(
      column + 1,
      ...overlapping.map((layout) => layout.columnCount),
      1,
    );
    for (const layout of overlapping) {
      layout.columnCount = Math.max(layout.columnCount, columnCount);
    }

    layouts.push({ ...item, column, columnCount });
  }

  for (let i = 0; i < layouts.length; i++) {
    for (let j = i + 1; j < layouts.length; j++) {
      if (timedEventsOverlapInTime(layouts[i], layouts[j])) {
        const maxColumns = Math.max(layouts[i].columnCount, layouts[j].columnCount);
        layouts[i].columnCount = maxColumns;
        layouts[j].columnCount = maxColumns;
      }
    }
  }

  return layouts;
}

/** Slightly wider than equal columns so events overlap, but less than full cascade. */
export function timedEventOverlapPositionStyle(
  column: number,
  columnCount: number,
): {
  left: string;
  width: string;
  zIndex: number;
} {
  if (columnCount <= 1) {
    return {
      left: "2px",
      width: "calc(100% - 4px)",
      zIndex: 1,
    };
  }

  const slotPct = 100 / columnCount;
  const overlapPct = Math.min(6, slotPct / 4);
  const widthPct = slotPct + overlapPct;
  const leftPct = column * (slotPct - overlapPct);

  return {
    left: `calc(${leftPct}% + 2px)`,
    width: `calc(${widthPct}% - 4px)`,
    zIndex: column + 1,
  };
}

/** Vertical position of "now" on the day/week grid, or null if outside the visible hours. */
export function currentTimeGridTopPct(now: Date = new Date()): number | null {
  const gridStartMin = CALENDAR_GRID_START_HOUR * 60;
  const nowMin = minutesFromMidnight(now);
  if (nowMin < gridStartMin || nowMin > gridStartMin + CALENDAR_GRID_TOTAL_MINUTES) {
    return null;
  }
  return ((nowMin - gridStartMin) / CALENDAR_GRID_TOTAL_MINUTES) * 100;
}

export function daySpanMs(start: Date, end: Date): number {
  return Math.max(end.getTime() - start.getTime(), 15 * 60 * 1000);
}

export { DAY_MS };
