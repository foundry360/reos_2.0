"use client";

import Link from "next/link";
import { createPortal } from "react-dom";
import { useEffect, useState } from "react";
import {
  formatCalendarEventDateLine,
  formatCalendarEventTimeLine,
} from "@/lib/calendar/calendar-date";
import type { CalendarEvent } from "@/lib/calendar/calendar-types";
import { CalendarDeleteAppointmentModal } from "./calendar-delete-appointment-modal";
import shellStyles from "@/components/shell/shell.module.css";
import styles from "./calendar.module.css";

function IconClose() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path
        d="M6 6l12 12M18 6 6 18"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
      />
    </svg>
  );
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

interface CalendarEventDetailModalProps {
  event: CalendarEvent;
  open: boolean;
  onClose: () => void;
}

export function CalendarEventDetailModal({
  event,
  open,
  onClose,
}: CalendarEventDetailModalProps) {
  const [mounted, setMounted] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const deletable = canDeleteEvent(event);

  useEffect(() => {
    setMounted(true);
  }, []);

  useEffect(() => {
    if (!open) {
      setDeleteOpen(false);
      return;
    }
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape" && !deleteOpen) onClose();
    }
    document.addEventListener("keydown", onKeyDown);
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      document.body.style.overflow = "";
    };
  }, [open, deleteOpen, onClose]);

  if (!open || !mounted) return null;

  const dateLine = formatCalendarEventDateLine(event);
  const timeLine = formatCalendarEventTimeLine(event);
  const hasVideo = Boolean(event.conferenceUrl || event.conferenceHostUrl);

  return (
    <>
      {createPortal(
        <div
          className={shellStyles.modalOverlay}
          onClick={() => !deleteOpen && onClose()}
        >
          <div
            className={`${shellStyles.modalPanel} ${styles.eventDetailModalPanel}`}
            role="dialog"
            aria-modal="true"
            aria-labelledby="calendar-event-detail-title"
            onClick={(e) => e.stopPropagation()}
          >
            <div className={shellStyles.modalHeader}>
              <div className={shellStyles.modalHeaderText}>
                <h2 id="calendar-event-detail-title" className={shellStyles.modalTitle}>
                  {event.title}
                </h2>
              </div>
              <div className={styles.eventDetailModalHeaderActions}>
                {deletable ? (
                  <button
                    type="button"
                    className={`${shellStyles.iconBtn} ${styles.eventDetailModalDeleteIcon}`}
                    aria-label="Delete appointment"
                    title="Delete"
                    onClick={() => setDeleteOpen(true)}
                  >
                    <IconTrash />
                  </button>
                ) : null}
                <button
                  type="button"
                  className={shellStyles.iconBtn}
                  aria-label="Close"
                  onClick={onClose}
                >
                  <IconClose />
                </button>
              </div>
            </div>

            <div className={shellStyles.modalBody}>
              <dl className={styles.eventDetailModalMeta}>
                <div className={styles.eventDetailModalRow}>
                  <dt>Date</dt>
                  <dd>{dateLine}</dd>
                </div>
                <div className={styles.eventDetailModalRow}>
                  <dt>Time</dt>
                  <dd>{timeLine}</dd>
                </div>
                {event.contactName ? (
                  <div className={styles.eventDetailModalRow}>
                    <dt>With</dt>
                    <dd>
                      {event.href ? (
                        <Link href={event.href} className={styles.eventDetailModalInlineLink}>
                          {event.contactName}
                        </Link>
                      ) : (
                        event.contactName
                      )}
                    </dd>
                  </div>
                ) : null}
                {event.location ? (
                  <div className={styles.eventDetailModalRow}>
                    <dt>Location</dt>
                    <dd>{event.location}</dd>
                  </div>
                ) : null}
                {hasVideo ? (
                  <div className={styles.eventDetailModalRow}>
                    <dt>Video</dt>
                    <dd className={styles.eventDetailModalLinks}>
                      {event.conferenceHostUrl ? (
                        <a
                          href={event.conferenceHostUrl}
                          target="_blank"
                          rel="noopener noreferrer"
                          className={styles.eventDetailModalInlineLink}
                        >
                          {event.conferenceHostUrl}
                        </a>
                      ) : null}
                      {event.conferenceUrl ? (
                        <a
                          href={event.conferenceUrl}
                          target="_blank"
                          rel="noopener noreferrer"
                          className={styles.eventDetailModalInlineLink}
                        >
                          {event.conferenceUrl}
                        </a>
                      ) : null}
                    </dd>
                  </div>
                ) : null}
                {event.body ? (
                  <div className={styles.eventDetailModalRow}>
                    <dt>Notes</dt>
                    <dd className={styles.eventDetailModalNotes}>{event.body}</dd>
                  </div>
                ) : null}
              </dl>
            </div>
          </div>
        </div>,
        document.body,
      )}

      <CalendarDeleteAppointmentModal
        event={event}
        open={deleteOpen}
        onClose={() => setDeleteOpen(false)}
        onDeleted={onClose}
      />
    </>
  );
}
