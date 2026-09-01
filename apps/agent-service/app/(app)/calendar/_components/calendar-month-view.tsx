"use client";

import {
  formatShortWeekday,
  getMonthGridDays,
  isToday,
  parseIsoDate,
  startOfMonth,
  toIsoDate,
} from "@/lib/calendar/calendar-date";
import type { CalendarEvent } from "@/lib/calendar/calendar-types";
import { eventOverlapsDay } from "@/lib/calendar/calendar-date";
import { CalendarEventChip } from "./calendar-event-chip";
import styles from "./calendar.module.css";

const WEEKDAYS = [0, 1, 2, 3, 4, 5, 6].map((offset) => {
  const d = new Date(2024, 0, 7 + offset);
  return formatShortWeekday(d);
});

const MAX_VISIBLE = 3;

interface CalendarMonthViewProps {
  anchorDate: string;
  events: CalendarEvent[];
  onSelectDay: (date: string) => void;
}

export function CalendarMonthView({
  anchorDate,
  events,
  onSelectDay,
}: CalendarMonthViewProps) {
  const anchor = parseIsoDate(anchorDate);
  const monthStart = startOfMonth(anchor);
  const days = getMonthGridDays(anchor);

  function eventsForDay(day: Date): CalendarEvent[] {
    return events.filter((event) =>
      eventOverlapsDay(new Date(event.start), new Date(event.end), day),
    );
  }

  return (
    <div className={styles.monthGrid}>
      {WEEKDAYS.map((label) => (
        <div key={label} className={styles.monthWeekday}>
          {label}
        </div>
      ))}
      {days.map((day) => {
        const dayEvents = eventsForDay(day);
        const visible = dayEvents.slice(0, MAX_VISIBLE);
        const hiddenCount = dayEvents.length - visible.length;
        const inMonth = day.getMonth() === monthStart.getMonth();
        const today = isToday(day);

        return (
          <div
            key={toIsoDate(day)}
            className={`${styles.monthCell}${inMonth ? "" : ` ${styles.monthCellMuted}`}${today ? ` ${styles.monthCellToday}` : ""}`}
          >
            <button
              type="button"
              className={`${styles.monthDayNum}${today ? ` ${styles.monthDayNumToday}` : ""}`}
              onClick={() => onSelectDay(toIsoDate(day))}
            >
              {day.getDate()}
            </button>
            <div className={styles.monthEvents}>
              {visible.map((event) => (
                <CalendarEventChip key={event.id} event={event} />
              ))}
              {hiddenCount > 0 ? (
                <button
                  type="button"
                  className={styles.monthMore}
                  onClick={() => onSelectDay(toIsoDate(day))}
                >
                  +{hiddenCount} more
                </button>
              ) : null}
            </div>
          </div>
        );
      })}
    </div>
  );
}
