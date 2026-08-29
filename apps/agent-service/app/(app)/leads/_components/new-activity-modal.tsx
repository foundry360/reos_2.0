"use client";

import { useEffect, useRef, useState, useTransition, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { useRouter } from "next/navigation";
import { createActivityAction } from "@/lib/crm/crm-actions";
import {
  ACTIVITY_TYPE_OPTIONS,
  type ActivityType,
} from "@/lib/crm/person-activities";
import { DropdownSelect } from "@/components/shell/dropdown-select";
import { DateInput } from "@/components/shell/date-input";
import { IconPlus } from "@/components/shell/sidebar-nav";
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

interface NewActivityModalProps {
  contactId: string;
  opportunityId?: string;
  defaultActivityType?: ActivityType;
  lockActivityType?: boolean;
  trigger?: "pill" | "link" | "cta" | "secondary" | "quickAction";
  linkLabel?: string;
  triggerIcon?: ReactNode;
  disabled?: boolean;
}

export function NewActivityModal({
  contactId,
  opportunityId,
  defaultActivityType = "note",
  lockActivityType = false,
  trigger = "pill",
  linkLabel = "Add",
  triggerIcon,
  disabled = false,
}: NewActivityModalProps) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const [activityType, setActivityType] = useState<ActivityType>(defaultActivityType);
  const [title, setTitle] = useState("");
  const [occurredDate, setOccurredDate] = useState("");
  const [mounted, setMounted] = useState(false);
  const panelRef = useRef<HTMLDivElement>(null);

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
      setActivityType(defaultActivityType);
      document.body.style.overflow = "hidden";
    } else {
      document.body.style.overflow = "";
    }
    return () => {
      document.body.style.overflow = "";
    };
  }, [open, defaultActivityType]);

  function resetForm() {
    setActivityType(defaultActivityType);
    setTitle("");
    setOccurredDate("");
    setError(null);
  }

  function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
    const formData = new FormData(e.currentTarget);
    formData.set("contactId", contactId);
    formData.set(
      "activityType",
      lockActivityType ? defaultActivityType : activityType,
    );
    if (opportunityId) {
      formData.set("opportunityId", opportunityId);
    }

    startTransition(async () => {
      const result = await createActivityAction(formData);
      if (!result.ok) {
        setError(result.error ?? "Could not create activity.");
        return;
      }
      resetForm();
      setOpen(false);
      router.refresh();
    });
  }

  const typeOptions = ACTIVITY_TYPE_OPTIONS.map((option) => ({
    value: option.value,
    label: option.label,
  }));

  const isNote = lockActivityType && defaultActivityType === "note";
  const hideDateField =
    (lockActivityType ? defaultActivityType : activityType) === "note";
  const modalTitle = isNote ? "Add Note" : "Log Activity";
  const modalSubtitle = isNote
    ? "Capture context and follow-ups for this record."
    : "Capture a note, call, email, or meeting on this record.";
  const ctaLabel =
    linkLabel === "Add"
      ? isNote
        ? "Add a Note"
        : "Add an Activity"
      : linkLabel === "Add the first one"
        ? isNote
          ? "Add a Note"
          : "Add an Activity"
        : linkLabel;

  const dialog =
    open && mounted
      ? createPortal(
          <div className={styles.modalOverlay} onClick={() => !pending && setOpen(false)}>
            <div
              ref={panelRef}
              className={styles.modalPanel}
              role="dialog"
              aria-modal="true"
              aria-labelledby="new-activity-title"
              onClick={(e) => e.stopPropagation()}
            >
              <div className={styles.modalHeader}>
                <div>
                  <h2 id="new-activity-title" className={styles.modalTitle}>
                    {modalTitle}
                  </h2>
                  <p className={styles.modalSubtitle}>{modalSubtitle}</p>
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

              <form className={styles.modalBody} onSubmit={handleSubmit}>
                {error && <p className={styles.error}>{error}</p>}

                {!lockActivityType ? (
                  <div className={styles.field}>
                    <label className={styles.label} htmlFor="new-activity-type">
                      Type
                    </label>
                    <DropdownSelect
                      id="new-activity-type"
                      value={activityType}
                      ariaLabel="Activity type"
                      disabled={pending}
                      onChange={(value) => setActivityType(value as ActivityType)}
                      options={typeOptions}
                    />
                  </div>
                ) : null}

                <div className={styles.field}>
                  <label className={styles.label} htmlFor="new-activity-title-input">
                    Title
                  </label>
                  <input
                    id="new-activity-title-input"
                    name="title"
                    className={styles.input}
                    value={title}
                    onChange={(e) => setTitle(e.target.value)}
                    placeholder={
                      isNote
                        ? "Follow-up from discovery call"
                        : "Left voicemail about listing"
                    }
                    required
                    disabled={pending}
                  />
                </div>

                {!hideDateField ? (
                  <div className={styles.field}>
                    <label className={styles.label} htmlFor="new-activity-date">
                      Date
                    </label>
                    <DateInput
                      id="new-activity-date"
                      name="occurredDate"
                      value={occurredDate}
                      onChange={(e) => setOccurredDate(e.target.value)}
                      disabled={pending}
                    />
                  </div>
                ) : null}

                <div className={styles.field}>
                  <label className={styles.label} htmlFor="new-activity-body">
                    {isNote ? "Note" : "Details"}
                  </label>
                  <textarea
                    id="new-activity-body"
                    name="body"
                    className={styles.input}
                    rows={3}
                    disabled={pending}
                    placeholder={isNote ? "Write your note…" : "Optional notes"}
                  />
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
                    {pending ? "Saving…" : isNote ? "Save Note" : "Save Activity"}
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
          {trigger === "pill" ? (
            <>
              <IconPlus />
              {isNote ? "New Note" : "New Activity"}
            </>
          ) : trigger === "secondary" ? (
            <>
              <IconPlus />
              {linkLabel === "Add the first one" ? "Add" : linkLabel}
            </>
          ) : (
            ctaLabel
          )}
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
