"use client";

import { useCallback } from "react";
import {
  calendarGridHeightPx,
  calendarGridHours,
  CALENDAR_GRID_HOUR_HEIGHT,
  eventOverlapsDay,
  formatShortWeekday,
  getWeekDays,
  isToday,
  parseIsoDate,
  toIsoDate,
} from "@/lib/calendar/calendar-date";
import type { CalendarEvent } from "@/lib/calendar/calendar-types";
import { CalendarEventChip } from "./calendar-event-chip";
import { CalendarCurrentTimeMarker } from "./calendar-current-time-marker";
import { layoutDayTimedEvents } from "./calendar-day-timed-events";
import { CalendarTimedEventBlock } from "./calendar-timed-event-block";
import { scrollCalendarTimeGridToDefault } from "./calendar-time-grid-scroll";
import styles from "./calendar.module.css";

const HOURS = calendarGridHours();
const GRID_HEIGHT = calendarGridHeightPx();

interface CalendarWeekViewProps {
  anchorDate: string;
  events: CalendarEvent[];
  onSelectDay: (date: string) => void;
}

export function CalendarWeekView({
  anchorDate,
  events,
  onSelectDay,
}: CalendarWeekViewProps) {
  const anchor = parseIsoDate(anchorDate);
  const days = getWeekDays(anchor);
  const scrollRef = useCallback(
    (node: HTMLDivElement | null) => {
      scrollCalendarTimeGridToDefault(node);
    },
    [anchorDate],
  );

  function eventsForDay(day: Date): CalendarEvent[] {
    return events.filter((event) =>
      eventOverlapsDay(new Date(event.start), new Date(event.end), day),
    );
  }

  const allDayEvents = days.map((day) =>
    eventsForDay(day).filter((event) => event.allDay),
  );
  const hasAllDay = allDayEvents.some((list) => list.length > 0);

  return (
    <div className={styles.timeGridWrap}>
      <div className={`${styles.weekHeader}`}>
        <div className={styles.weekHeaderCell} />
        {days.map((day) => {
          const today = isToday(day);
          return (
            <div key={toIsoDate(day)} className={styles.weekHeaderCell}>
              <div className={styles.weekHeaderWeekday}>{formatShortWeekday(day)}</div>
              <button
                type="button"
                className={`${styles.weekHeaderDate}${today ? ` ${styles.weekHeaderDateToday}` : ""}`}
                onClick={() => onSelectDay(toIsoDate(day))}
              >
                {day.getDate()}
              </button>
            </div>
          );
        })}
      </div>

      {hasAllDay ? (
        <div className={`${styles.allDayRow} ${styles.allDayRowWeek}`}>
          <div className={styles.allDayLabel}>All day</div>
          <div className={`${styles.allDayCells}`}>
            {days.map((day, index) => (
              <div key={toIsoDate(day)} className={styles.allDayCell}>
                {allDayEvents[index].map((event) => (
                  <CalendarEventChip key={event.id} event={event} />
                ))}
              </div>
            ))}
          </div>
        </div>
      ) : null}

      <div ref={scrollRef} className={styles.timeGridScroll}>
        <div className={`${styles.timeGrid} ${styles.timeGridWeek}`}>
        <div className={styles.timeLabels}>
          {HOURS.map((hour) => (
            <div key={hour} className={styles.timeLabel} style={{ height: CALENDAR_GRID_HOUR_HEIGHT }}>
              {new Intl.DateTimeFormat("en-US", { hour: "numeric" }).format(
                new Date(2024, 0, 1, hour),
              )}
            </div>
          ))}
        </div>

        {days.map((day) => {
          const dayEvents = eventsForDay(day);
          const layout = layoutDayTimedEvents(dayEvents, day);
          const today = isToday(day);

          return (
            <div
              key={toIsoDate(day)}
              className={`${styles.timeColumn}${today ? ` ${styles.timeColumnToday}` : ""}`}
              style={{ height: GRID_HEIGHT }}
            >
              {HOURS.map((hour) => (
                <div
                  key={hour}
                  className={styles.hourLine}
                  style={{ height: CALENDAR_GRID_HOUR_HEIGHT }}
                />
              ))}
              {layout.map(({ event, topMin, heightMin, column, columnCount }) => (
                <CalendarTimedEventBlock
                  key={event.id}
                  event={event}
                  topMin={topMin}
                  heightMin={heightMin}
                  column={column}
                  columnCount={columnCount}
                />
              ))}
              <CalendarCurrentTimeMarker visible={today} />
            </div>
          );
        })}
        </div>
      </div>
    </div>
  );
}
