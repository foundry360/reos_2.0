"use client";

import Link from "next/link";
import {
  timedEventGridStyle,
  timedEventOverlapPositionStyle,
} from "@/lib/calendar/calendar-date";
import type { CalendarEvent } from "@/lib/calendar/calendar-types";
import { eventColor, eventTextColor } from "@/lib/calendar/calendar-types";
import { CalendarEventHoverDetail } from "./calendar-event-hover-detail";
import styles from "./calendar.module.css";

interface CalendarTimedEventBlockProps {
  event: CalendarEvent;
  topMin: number;
  heightMin: number;
  column: number;
  columnCount: number;
  showEndTime?: boolean;
}

function eventBorderColor(color: string): string {
  return `color-mix(in srgb, ${color} 72%, #000)`;
}

export function CalendarTimedEventBlock({
  event,
  topMin,
  heightMin,
  column,
  columnCount,
  showEndTime = false,
}: CalendarTimedEventBlockProps) {
  const { topPct, heightPct } = timedEventGridStyle(topMin, heightMin);
  const overlapStyle = timedEventOverlapPositionStyle(column, columnCount);
  const compact = heightMin < 36;
  const color = eventColor(event.kind);
  const textColor = eventTextColor(event.kind);

  const inner = (
    <>
      <div className={styles.timedEventTitle}>{event.title}</div>
      {!compact ? (
        <div className={styles.timedEventTime}>
          {new Intl.DateTimeFormat("en-US", {
            hour: "numeric",
            minute: "2-digit",
          }).format(new Date(event.start))}
          {showEndTime ? (
            <>
              {" – "}
              {new Intl.DateTimeFormat("en-US", {
                hour: "numeric",
                minute: "2-digit",
              }).format(new Date(event.end))}
            </>
          ) : null}
        </div>
      ) : null}
    </>
  );

  const style = {
    top: `${topPct}%`,
    height: `${heightPct}%`,
    left: overlapStyle.left,
    width: overlapStyle.width,
    zIndex: overlapStyle.zIndex,
    backgroundColor: color,
    borderColor: eventBorderColor(color),
    color: textColor,
  };

  const className = `${styles.timedEvent}${compact ? ` ${styles.timedEventCompact}` : ""}`;

  return (
    <CalendarEventHoverDetail event={event} className={className} style={style}>
      {event.href ? (
        <Link href={event.href} className={styles.timedEventSurface}>
          {inner}
        </Link>
      ) : (
        <div className={styles.timedEventSurface}>{inner}</div>
      )}
    </CalendarEventHoverDetail>
  );
}
