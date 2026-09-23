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
import { CalendarDeleteAppointmentModal } from "./calendar-delete-appointment-modal";
import { CalendarEventDetailModal } from "./calendar-event-detail-modal";
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

function IconTrash() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path
        d="M4 7h16"
        stroke="currentColor"
        strokeWidth="1.75"
        strokeLinecap="round"
      />
      <path
        d="M9 7V5.5A1.5 1.5 0 0 1 10.5 4h3A1.5 1.5 0 0 1 15 5.5V7"
        stroke="currentColor"
        strokeWidth="1.75"
        strokeLinecap="round"
      />
      <path
        d="M6.5 7v11.5A1.5 1.5 0 0 0 8 20h8a1.5 1.5 0 0 0 1.5-1.5V7"
        stroke="currentColor"
        strokeWidth="1.75"
        strokeLinejoin="round"
      />
      <path
        d="M10 11v5M14 11v5"
        stroke="currentColor"
        strokeWidth="1.75"
        strokeLinecap="round"
      />
    </svg>
  );
}

function canDeleteEvent(event: CalendarEvent): boolean {
  return event.kind === "appointment" && event.id.startsWith("activity:");
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
  const [detailOpen, setDetailOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [mounted, setMounted] = useState(false);
  const [position, setPosition] = useState({ top: 0, left: 0 });
  const deletable = canDeleteEvent(event);
  const showDetailCta = event.kind === "appointment" || Boolean(event.href);
  const blockingModal = detailOpen || deleteOpen;

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
    if (blockingModal) return;
    clearHideTimer();
    hideTimerRef.current = window.setTimeout(() => setOpen(false), HIDE_DELAY_MS);
  }, [clearHideTimer, blockingModal]);

  const show = useCallback(() => {
    clearHideTimer();
    setOpen(true);
  }, [clearHideTimer]);

  useLayoutEffect(() => {
    if (!open || blockingModal) return;

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
  }, [open, blockingModal, event.id]);

  useEffect(() => {
    if (!open || blockingModal) return;

    function close() {
      setOpen(false);
    }

    window.addEventListener("scroll", close, true);
    window.addEventListener("resize", close);
    return () => {
      window.removeEventListener("scroll", close, true);
      window.removeEventListener("resize", close);
    };
  }, [open, blockingModal]);

  function openDelete(e: React.MouseEvent) {
    e.preventDefault();
    e.stopPropagation();
    if (!deletable) return;
    clearHideTimer();
    setOpen(false);
    setDeleteOpen(true);
  }

  function openDetails(e: React.MouseEvent) {
    e.preventDefault();
    e.stopPropagation();
    clearHideTimer();
    setOpen(false);
    setDetailOpen(true);
  }

  const color = eventColor(event.kind);
  const dateLine = formatCalendarEventDateLine(event);
  const timeLine = formatCalendarEventTimeLine(event);

  const popover =
    open && mounted && !blockingModal ? (
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
          <div className={styles.eventDetailHeader}>
            <p className={styles.eventDetailKind} style={{ color }}>
              {CALENDAR_EVENT_KIND_LABELS[event.kind]}
            </p>
            {deletable ? (
              <button
                type="button"
                className={styles.eventDetailDelete}
                aria-label="Remove from calendar"
                title="Remove from calendar"
                onClick={openDelete}
              >
                <IconTrash />
              </button>
            ) : null}
          </div>
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
          {showDetailCta ? (
            event.kind === "appointment" ? (
              <button
                type="button"
                className={styles.eventDetailLink}
                onClick={openDetails}
              >
                View details
              </button>
            ) : event.href ? (
              <Link href={event.href} className={styles.eventDetailLink}>
                View details
              </Link>
            ) : null
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
      <CalendarEventDetailModal
        event={event}
        open={detailOpen}
        onClose={() => setDetailOpen(false)}
      />
      <CalendarDeleteAppointmentModal
        event={event}
        open={deleteOpen}
        onClose={() => setDeleteOpen(false)}
      />
    </>
  );
}
