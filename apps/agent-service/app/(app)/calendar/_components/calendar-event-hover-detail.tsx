"use client";

import Link from "next/link";
import { createPortal } from "react-dom";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";
import {
  formatCalendarEventDateLine,
  formatCalendarEventTimeLine,
} from "@/lib/calendar/calendar-date";
import type { CalendarEvent } from "@/lib/calendar/calendar-types";
import {
  CALENDAR_EVENT_KIND_LABELS,
  eventColor,
} from "@/lib/calendar/calendar-types";
import styles from "./calendar.module.css";

const GAP_PX = 10;
const HIDE_DELAY_MS = 120;
const VIEWPORT_PADDING_PX = 8;

interface CalendarEventHoverDetailProps {
  event: CalendarEvent;
  className?: string;
  style?: CSSProperties;
  children: ReactNode;
}

function computePopoverPosition(
  anchor: DOMRect,
  popoverWidth: number,
  popoverHeight: number,
): { top: number; left: number } {
  let left = anchor.right + GAP_PX;
  let top = anchor.top;

  if (left + popoverWidth > window.innerWidth - VIEWPORT_PADDING_PX) {
    left = anchor.left - popoverWidth - GAP_PX;
  }

  if (top + popoverHeight > window.innerHeight - VIEWPORT_PADDING_PX) {
    top = window.innerHeight - popoverHeight - VIEWPORT_PADDING_PX;
  }

  if (top < VIEWPORT_PADDING_PX) top = VIEWPORT_PADDING_PX;
  if (left < VIEWPORT_PADDING_PX) left = VIEWPORT_PADDING_PX;

  return { top, left };
}

export function CalendarEventHoverDetail({
  event,
  className,
  style,
  children,
}: CalendarEventHoverDetailProps) {
  const anchorRef = useRef<HTMLDivElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);
  const hideTimerRef = useRef<number | null>(null);
  const [open, setOpen] = useState(false);
  const [mounted, setMounted] = useState(false);
  const [position, setPosition] = useState({ top: 0, left: 0 });

  useEffect(() => {
    setMounted(true);
  }, []);

  const clearHideTimer = useCallback(() => {
    if (hideTimerRef.current !== null) {
      window.clearTimeout(hideTimerRef.current);
      hideTimerRef.current = null;
    }
  }, []);

  const scheduleHide = useCallback(() => {
    clearHideTimer();
    hideTimerRef.current = window.setTimeout(() => setOpen(false), HIDE_DELAY_MS);
  }, [clearHideTimer]);

  const show = useCallback(() => {
    clearHideTimer();
    setOpen(true);
  }, [clearHideTimer]);

  useLayoutEffect(() => {
    if (!open) return;

    const anchor = anchorRef.current;
    const popover = popoverRef.current;
    if (!anchor || !popover) return;

    const anchorRect = anchor.getBoundingClientRect();
    const next = computePopoverPosition(
      anchorRect,
      popover.offsetWidth,
      popover.offsetHeight,
    );
    setPosition(next);
  }, [open, event.id]);

  useEffect(() => {
    if (!open) return;

    function close() {
      setOpen(false);
    }

    window.addEventListener("scroll", close, true);
    window.addEventListener("resize", close);
    return () => {
      window.removeEventListener("scroll", close, true);
      window.removeEventListener("resize", close);
    };
  }, [open]);

  const color = eventColor(event.kind);
  const dateLine = formatCalendarEventDateLine(event);
  const timeLine = formatCalendarEventTimeLine(event);

  const popover =
    open && mounted ? (
      <div
        ref={popoverRef}
        className={styles.eventDetailPopover}
        style={{ top: position.top, left: position.left }}
        role="tooltip"
        onMouseEnter={show}
        onMouseLeave={scheduleHide}
      >
        <div
          className={styles.eventDetailAccent}
          style={{ backgroundColor: color }}
          aria-hidden
        />
        <div className={styles.eventDetailBody}>
          <p
            className={styles.eventDetailKind}
            style={{ color }}
          >
            {CALENDAR_EVENT_KIND_LABELS[event.kind]}
          </p>
          <h3 className={styles.eventDetailTitle}>{event.title}</h3>
          <dl className={styles.eventDetailMeta}>
            <div className={styles.eventDetailRow}>
              <dt>Date</dt>
              <dd>{dateLine}</dd>
            </div>
            <div className={styles.eventDetailRow}>
              <dt>Time</dt>
              <dd>{timeLine}</dd>
            </div>
            {event.subtitle ? (
              <div className={styles.eventDetailRow}>
                <dt>Details</dt>
                <dd>{event.subtitle}</dd>
              </div>
            ) : null}
          </dl>
          {event.href ? (
            <Link href={event.href} className={styles.eventDetailLink}>
              View details
            </Link>
          ) : null}
        </div>
      </div>
    ) : null;

  return (
    <>
      <div
        ref={anchorRef}
        className={`${className ?? ""}${open ? ` ${styles.eventHoverOpen}` : ""}`.trim()}
        style={style}
        onMouseEnter={show}
        onMouseLeave={scheduleHide}
        onFocus={show}
        onBlur={scheduleHide}
      >
        {children}
      </div>
      {mounted && popover ? createPortal(popover, document.body) : null}
    </>
  );
}
