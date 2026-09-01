"use client";

import Link from "next/link";
import {
  addDays,
  formatAgendaHeading,
  formatTime,
  parseIsoDate,
  sameDay,
  startOfDay,
  toIsoDate,
} from "@/lib/calendar/calendar-date";
import type { CalendarEvent } from "@/lib/calendar/calendar-types";
import { eventColor } from "@/lib/calendar/calendar-types";
import { CalendarEventHoverDetail } from "./calendar-event-hover-detail";
import styles from "./calendar.module.css";

interface CalendarAgendaViewProps {
  anchorDate: string;
  events: CalendarEvent[];
}

function groupByDay(events: CalendarEvent[], anchor: Date): Map<string, CalendarEvent[]> {
  const map = new Map<string, CalendarEvent[]>();
  const end = addDays(startOfDay(anchor), 30);

  for (let cursor = startOfDay(anchor); cursor <= end; cursor = addDays(cursor, 1)) {
    map.set(toIsoDate(cursor), []);
  }

  for (const event of events) {
    const start = new Date(event.start);
    let cursor = startOfDay(start);
    const eventEnd = new Date(event.end);
    while (cursor <= eventEnd && cursor <= end) {
      if (cursor >= startOfDay(anchor)) {
        const key = toIsoDate(cursor);
        const list = map.get(key);
        if (list) list.push(event);
      }
      cursor = addDays(cursor, 1);
    }
  }

  return map;
}

function formatEventTime(event: CalendarEvent, day: Date): string {
  if (event.allDay) return "All day";
  const start = new Date(event.start);
  const end = new Date(event.end);
  if (sameDay(start, end) || sameDay(start, day)) {
    return `${formatTime(event.start)} – ${formatTime(event.end)}`;
  }
  return formatTime(event.start);
}

export function CalendarAgendaView({ anchorDate, events }: CalendarAgendaViewProps) {
  const anchor = parseIsoDate(anchorDate);
  const grouped = groupByDay(events, anchor);
  const daysWithEvents = [...grouped.entries()].filter(([, list]) => list.length > 0);

  if (daysWithEvents.length === 0) {
    return (
      <p className={styles.agendaEmpty}>
        No events in the next 30 days. Try adjusting filters or pick another date.
      </p>
    );
  }

  return (
    <div className={styles.agendaList}>
      {daysWithEvents.map(([dateKey, dayEvents]) => {
        const day = parseIsoDate(dateKey);
        return (
          <section key={dateKey} className={styles.agendaDay}>
            <h3 className={styles.agendaDayHeading}>{formatAgendaHeading(day)}</h3>
            {dayEvents.map((event) => {
              const color = eventColor(event.kind);
              const body = (
                <>
                  <span className={styles.agendaCardBar} style={{ backgroundColor: color }} />
                  <span className={styles.agendaCardBody}>
                    <p className={styles.agendaCardTitle}>{event.title}</p>
                    {event.subtitle ? (
                      <p className={styles.agendaCardMeta}>{event.subtitle}</p>
                    ) : null}
                  </span>
                </>
              );

              return (
                <div key={`${dateKey}:${event.id}`} className={styles.agendaItem}>
                  <div className={styles.agendaTime}>{formatEventTime(event, day)}</div>
                  <CalendarEventHoverDetail event={event} className={styles.agendaCardWrap}>
                    {event.href ? (
                      <Link href={event.href} className={styles.agendaCard}>
                        {body}
                      </Link>
                    ) : (
                      <div className={styles.agendaCard}>{body}</div>
                    )}
                  </CalendarEventHoverDetail>
                </div>
              );
            })}
          </section>
        );
      })}
    </div>
  );
}
