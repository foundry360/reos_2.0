"use client";

import Link from "next/link";
import { createPortal } from "react-dom";
import { useRouter } from "next/navigation";
import { useEffect, useState, useTransition } from "react";
import { APPOINTMENT_STATUS_LABELS } from "@/lib/calendar/appointment-status";
import {
  formatCalendarEventDateLine,
  formatCalendarEventTimeLine,
} from "@/lib/calendar/calendar-date";
import type { CalendarEvent } from "@/lib/calendar/calendar-types";
import { markCalendarAppointmentAction } from "@/lib/crm/crm-actions";
import { CalendarCancelAppointmentModal } from "./calendar-cancel-appointment-modal";
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

function isScheduledAppointment(event: CalendarEvent): boolean {
  return (
    event.kind === "appointment" &&
    event.id.startsWith("activity:") &&
    (event.appointmentStatus ?? "scheduled") === "scheduled"
  );
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
  const router = useRouter();
  const [mounted, setMounted] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [outcomeError, setOutcomeError] = useState<string | null>(null);
  const [outcomePending, startOutcome] = useTransition();
  const deletable = isScheduledAppointment(event);
  // Attendance is recorded by the team once the appointment has started; never inferred.
  const canRecordOutcome = deletable && Date.parse(event.start) <= Date.now();

  function recordOutcome(outcome: "completed" | "no_show") {
    if (outcomePending) return;
    setOutcomeError(null);
    startOutcome(async () => {
      const result = await markCalendarAppointmentAction(event.id, outcome);
      if (!result.ok) {
        setOutcomeError(result.error ?? "Could not update the appointment.");
        return;
      }
      onClose();
      router.refresh();
    });
  }

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
                    aria-label="Cancel appointment"
                    title="Cancel appointment"
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
                {event.appointmentStatus && event.appointmentStatus !== "scheduled" ? (
                  <div className={styles.eventDetailModalRow}>
                    <dt>Status</dt>
                    <dd>{APPOINTMENT_STATUS_LABELS[event.appointmentStatus]}</dd>
                  </div>
                ) : null}
              </dl>
              {canRecordOutcome ? (
                <>
                  {outcomeError ? <p className={shellStyles.error}>{outcomeError}</p> : null}
                  <div className={shellStyles.modalFooter}>
                    <button
                      type="button"
                      className={shellStyles.btnSecondary}
                      onClick={() => recordOutcome("no_show")}
                      disabled={outcomePending}
                    >
                      No-show
                    </button>
                    <button
                      type="button"
                      className={shellStyles.btnPrimary}
                      onClick={() => recordOutcome("completed")}
                      disabled={outcomePending}
                    >
                      Completed
                    </button>
                  </div>
                </>
              ) : null}
            </div>
          </div>
        </div>,
        document.body,
      )}

      <CalendarCancelAppointmentModal
        event={event}
        open={deleteOpen}
        onClose={() => setDeleteOpen(false)}
        onCancelled={onClose}
      />
    </>
  );
}
