"use client";

import Link from "next/link";
import type { CalendarEvent } from "@/lib/calendar/calendar-types";
import { eventColor, eventTextColor } from "@/lib/calendar/calendar-types";
import { CalendarEventHoverDetail } from "./calendar-event-hover-detail";
import styles from "./calendar.module.css";

interface CalendarEventChipProps {
  event: CalendarEvent;
  className?: string;
  onNavigate?: () => void;
}

export function CalendarEventChip({
  event,
  className,
  onNavigate,
}: CalendarEventChipProps) {
  const color = eventColor(event.kind);
  const textColor = eventTextColor(event.kind);
  const borderColor = `color-mix(in srgb, ${color} 72%, #000)`;
  const chipClassName = `${styles.eventChip} ${className ?? ""}`;
  const chipStyle = { backgroundColor: color, borderColor, color: textColor };
  const content = event.title;

  if (event.href) {
    return (
      <CalendarEventHoverDetail event={event} className={styles.eventChipWrap}>
        <Link
          href={event.href}
          className={chipClassName}
          style={chipStyle}
          onClick={onNavigate}
        >
          {content}
        </Link>
      </CalendarEventHoverDetail>
    );
  }

  return (
    <CalendarEventHoverDetail event={event} className={styles.eventChipWrap}>
      <button type="button" className={chipClassName} style={chipStyle}>
        {content}
      </button>
    </CalendarEventHoverDetail>
  );
}
