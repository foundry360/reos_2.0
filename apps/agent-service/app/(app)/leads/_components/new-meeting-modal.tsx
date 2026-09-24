"use client";

import { useEffect, useRef, useState, useTransition, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { useRouter } from "next/navigation";
import { createActivityAction } from "@/lib/crm/crm-actions";
import { CONSULT_MINUTES } from "@/lib/calendar/consult-slots";
import { DateInput } from "@/components/shell/date-input";
import { TimeInput } from "@/components/shell/time-input";
import { LocationTypeahead } from "@/components/shell/location-typeahead";
import styles from "@/components/shell/shell.module.css";

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

function IconVideo() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <rect
        x="2.5"
        y="6"
        width="13"
        height="12"
        rx="2.5"
        stroke="currentColor"
        strokeWidth="1.75"
      />
      <path
        d="M15.5 10.5 21 7.5v9l-5.5-3"
        stroke="currentColor"
        strokeWidth="1.75"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function toIsoDate(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function todayIso(): string {
  return toIsoDate(new Date());
}

function addMinutesToTime(time: string, minutes: number): string {
  const match = /^(\d{2}):(\d{2})$/.exec(time);
  if (!match) return "10:30";
  const total = Number(match[1]) * 60 + Number(match[2]) + minutes;
  const hours = Math.floor((((total % (24 * 60)) + 24 * 60) % (24 * 60)) / 60);
  const mins = ((total % (24 * 60)) + 24 * 60) % (24 * 60) % 60;
  return `${String(hours).padStart(2, "0")}:${String(mins).padStart(2, "0")}`;
}

interface NewMeetingModalProps {
  contactId: string;
  opportunityId?: string;
  trigger?: "pill" | "link" | "cta" | "secondary" | "quickAction";
  linkLabel?: string;
  triggerIcon?: ReactNode;
  disabled?: boolean;
}

export function NewMeetingModal({
  contactId,
  opportunityId,
  trigger = "quickAction",
  linkLabel = "Meeting",
  triggerIcon,
  disabled = false,
}: NewMeetingModalProps) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const [title, setTitle] = useState("");
  const [startDate, setStartDate] = useState(todayIso);
  const [startTime, setStartTime] = useState("10:00");
  const [endDate, setEndDate] = useState(todayIso);
  const [endTime, setEndTime] = useState(addMinutesToTime("10:00", CONSULT_MINUTES));
  const [addVideo, setAddVideo] = useState(false);
  const [location, setLocation] = useState("");
  const [body, setBody] = useState("");
  const [mounted, setMounted] = useState(false);
  const panelRef = useRef<HTMLDivElement>(null);
  const endTouchedRef = useRef(false);

  useEffect(() => {
    setMounted(true);
  }, []);

  useEffect(() => {
    if (!open) return;
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape" && !pending) setOpen(false);
    }
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [open, pending]);

  useEffect(() => {
    if (open) {
      setError(null);
      document.body.style.overflow = "hidden";
    } else {
      document.body.style.overflow = "";
    }
    return () => {
      document.body.style.overflow = "";
    };
  }, [open]);

  function resetForm() {
    const today = todayIso();
    setTitle("");
    setStartDate(today);
    setStartTime("10:00");
    setEndDate(today);
    setEndTime(addMinutesToTime("10:00", CONSULT_MINUTES));
    setAddVideo(false);
    setLocation("");
    setBody("");
    setError(null);
    endTouchedRef.current = false;
  }

  function handleStartTimeChange(value: string) {
    setStartTime(value);
    if (!endTouchedRef.current) {
      setEndTime(addMinutesToTime(value || "10:00", CONSULT_MINUTES));
      setEndDate(startDate);
    }
  }

  function handleStartDateChange(value: string) {
    setStartDate(value);
    if (!endTouchedRef.current) {
      setEndDate(value);
    }
  }

  function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
    if (!title.trim()) {
      setError("Meeting title is required.");
      return;
    }
    if (!startDate) {
      setError("Select a meeting date.");
      return;
    }
    if (!startTime) {
      setError("Select a start time.");
      return;
    }

    const formData = new FormData();
    formData.set("contactId", contactId);
    formData.set("activityType", "meeting");
    formData.set("title", title.trim());
    formData.set("body", body.trim());
    formData.set("startDate", startDate);
    formData.set("startTime", startTime);
    formData.set("endDate", endDate || startDate);
    formData.set("endTime", endTime || addMinutesToTime(startTime, CONSULT_MINUTES));
    formData.set("locationMode", addVideo ? "video" : "in_person");
    formData.set("addVideo", addVideo ? "true" : "false");
    if (location.trim()) {
      formData.set("location", location.trim());
    }
    if (opportunityId) {
      formData.set("opportunityId", opportunityId);
    }

    startTransition(async () => {
      const result = await createActivityAction(formData);
      if (!result.ok) {
        setError(result.error ?? "Could not schedule meeting.");
        return;
      }
      resetForm();
      setOpen(false);
      router.refresh();
    });
  }

  const dialog =
    open && mounted
      ? createPortal(
          <div className={styles.modalOverlay} onClick={() => !pending && setOpen(false)}>
            <div
              ref={panelRef}
              className={`${styles.modalPanel} ${styles.modalPanelWide} ${styles.modalPanelMeeting}`}
              role="dialog"
              aria-modal="true"
              aria-labelledby="new-meeting-title"
              onClick={(e) => e.stopPropagation()}
            >
              <div className={styles.modalHeader}>
                <div className={styles.modalHeaderText}>
                  <h2 id="new-meeting-title" className={styles.modalTitle}>
                    Schedule Meeting
                  </h2>
                  <p className={styles.modalSubtitle}>
                    Set the time and we&apos;ll add it to the calendar and email invites when
                    possible.
                  </p>
                </div>
                <button
                  type="button"
                  className={styles.iconBtn}
                  aria-label="Close"
                  onClick={() => setOpen(false)}
                  disabled={pending}
                >
                  <IconClose />
                </button>
              </div>

              <form className={styles.modalForm} onSubmit={handleSubmit}>
                <div className={`${styles.modalBody} ${styles.modalBodyScroll}`}>
                  {error ? <p className={styles.error}>{error}</p> : null}

                  <div className={styles.field}>
                    <label className={styles.label} htmlFor="new-meeting-title-input">
                      Title
                    </label>
                    <input
                      id="new-meeting-title-input"
                      className={styles.input}
                      value={title}
                      onChange={(e) => setTitle(e.target.value)}
                      placeholder="Consult / listing appointment"
                      required
                      disabled={pending}
                    />
                  </div>

                  <p className={styles.modalSectionLabel}>When</p>

                  <div className={styles.meetingWhenRow}>
                    <DateInput
                      id="new-meeting-start-date"
                      value={startDate}
                      onChange={(e) => handleStartDateChange(e.target.value)}
                      disabled={pending}
                      required
                      aria-label="Start date"
                      emptyLabel="Select a date"
                    />
                    <TimeInput
                      id="new-meeting-start-time"
                      value={startTime}
                      onChange={(e) => handleStartTimeChange(e.target.value)}
                      disabled={pending}
                      stepMinutes={15}
                      aria-label="Start time"
                      emptyLabel="Time"
                    />
                    <span className={styles.meetingWhenTo} aria-hidden="true">
                      to
                    </span>
                    <TimeInput
                      id="new-meeting-end-time"
                      value={endTime}
                      onChange={(e) => {
                        endTouchedRef.current = true;
                        setEndTime(e.target.value);
                      }}
                      disabled={pending}
                      stepMinutes={15}
                      aria-label="End time"
                      emptyLabel="Time"
                    />
                    <DateInput
                      id="new-meeting-end-date"
                      value={endDate}
                      onChange={(e) => {
                        endTouchedRef.current = true;
                        setEndDate(e.target.value);
                      }}
                      disabled={pending}
                      required
                      aria-label="End date"
                      emptyLabel="Select a date"
                    />
                  </div>

                  <div className={styles.field}>
                    <button
                      type="button"
                      id="new-meeting-add-video"
                      className={`${styles.meetingVideoOption} ${
                        addVideo ? styles.meetingVideoOptionActive : ""
                      }`}
                      aria-pressed={addVideo}
                      onClick={() => setAddVideo((current) => !current)}
                      disabled={pending}
                    >
                      <span className={styles.meetingVideoOptionIcon}>
                        <IconVideo />
                      </span>
                      <span>Add video conferencing</span>
                    </button>
                    {addVideo ? (
                      <p className={styles.fieldHint}>
                        Adds a public Jitsi Meet link everyone can open — no account required.
                      </p>
                    ) : null}
                  </div>

                  <div className={styles.field}>
                    <label className={styles.label} htmlFor="new-meeting-location">
                      Location
                    </label>
                    <LocationTypeahead
                      id="new-meeting-location"
                      value={location}
                      onChange={setLocation}
                      disabled={pending}
                      placeholder="Office or listing address"
                    />
                  </div>

                  <div className={styles.field}>
                    <label className={styles.label} htmlFor="new-meeting-body">
                      Details
                    </label>
                    <textarea
                      id="new-meeting-body"
                      className={styles.input}
                      rows={3}
                      value={body}
                      onChange={(e) => setBody(e.target.value)}
                      disabled={pending}
                      placeholder="Agenda or notes (optional)"
                    />
                  </div>
                </div>

                <div className={styles.modalFooter}>
                  <button
                    type="button"
                    className={styles.btnSecondary}
                    onClick={() => setOpen(false)}
                    disabled={pending}
                  >
                    Cancel
                  </button>
                  <button type="submit" className={styles.btnPrimary} disabled={pending}>
                    {pending ? "Scheduling…" : "Schedule Meeting"}
                  </button>
                </div>
              </form>
            </div>
          </div>,
          document.body,
        )
      : null;

  return (
    <>
      {trigger === "quickAction" ? (
        <button
          type="button"
          className={styles.personQuickAction}
          onClick={() => setOpen(true)}
          disabled={disabled || !contactId}
        >
          {triggerIcon ? (
            <span className={styles.personQuickActionIcon}>{triggerIcon}</span>
          ) : null}
          <span>{linkLabel}</span>
        </button>
      ) : trigger === "pill" || trigger === "cta" || trigger === "secondary" ? (
        <button
          type="button"
          className={`${trigger === "secondary" ? styles.btnSecondary : styles.btnPrimary} ${styles.btnPill}`}
          onClick={() => setOpen(true)}
          disabled={disabled || !contactId}
        >
          {linkLabel}
        </button>
      ) : (
        <button
          type="button"
          className={styles.modalLinkTrigger}
          onClick={() => setOpen(true)}
          disabled={disabled || !contactId}
        >
          {linkLabel}
        </button>
      )}

      {dialog}
    </>
  );
}
