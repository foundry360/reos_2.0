"use client";

import { useCallback } from "react";
import {
  calendarGridHeightPx,
  calendarGridHours,
  CALENDAR_GRID_HOUR_HEIGHT,
  eventOverlapsDay,
  formatShortWeekday,
  isToday,
  parseIsoDate,
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

interface CalendarDayViewProps {
  anchorDate: string;
  events: CalendarEvent[];
}

export function CalendarDayView({ anchorDate, events }: CalendarDayViewProps) {
  const day = parseIsoDate(anchorDate);
  const today = isToday(day);
  const scrollRef = useCallback(
    (node: HTMLDivElement | null) => {
      scrollCalendarTimeGridToDefault(node);
    },
    [anchorDate],
  );

  const dayEvents = events.filter((event) =>
    eventOverlapsDay(new Date(event.start), new Date(event.end), day),
  );
  const allDay = dayEvents.filter((event) => event.allDay);
  const timed = layoutDayTimedEvents(dayEvents, day);

  return (
    <div className={styles.timeGridWrap}>
      <div className={`${styles.weekHeader} ${styles.weekHeaderDay}`}>
        <div className={styles.weekHeaderCell} />
        <div className={styles.weekHeaderCell}>
          <div className={styles.weekHeaderWeekday}>{formatShortWeekday(day)}</div>
          <span
            className={`${styles.weekHeaderDate}${today ? ` ${styles.weekHeaderDateToday}` : ""}`}
          >
            {day.getDate()}
          </span>
        </div>
      </div>

      {allDay.length > 0 ? (
        <div className={`${styles.allDayRow} ${styles.allDayRowDay}`}>
          <div className={styles.allDayLabel}>All day</div>
          <div className={`${styles.allDayCells} ${styles.allDayCellsDay}`}>
            <div className={styles.allDayCell}>
              {allDay.map((event) => (
                <CalendarEventChip key={event.id} event={event} />
              ))}
            </div>
          </div>
        </div>
      ) : null}

      <div ref={scrollRef} className={styles.timeGridScroll}>
        <div className={`${styles.timeGrid} ${styles.timeGridDay}`}>
        <div className={styles.timeLabels}>
          {HOURS.map((hour) => (
            <div key={hour} className={styles.timeLabel} style={{ height: CALENDAR_GRID_HOUR_HEIGHT }}>
              {new Intl.DateTimeFormat("en-US", { hour: "numeric" }).format(
                new Date(2024, 0, 1, hour),
              )}
            </div>
          ))}
        </div>

        <div
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
          {timed.map(({ event, topMin, heightMin, column, columnCount }) => (
            <CalendarTimedEventBlock
              key={event.id}
              event={event}
              topMin={topMin}
              heightMin={heightMin}
              column={column}
              columnCount={columnCount}
              showEndTime
            />
          ))}
          <CalendarCurrentTimeMarker visible={today} />
        </div>
        </div>
      </div>
    </div>
  );
}
