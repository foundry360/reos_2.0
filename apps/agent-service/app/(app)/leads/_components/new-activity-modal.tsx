"use client";

import { useEffect, useRef, useState, useTransition } from "react";
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

interface NewActivityModalProps {
  contactId: string;
  trigger?: "pill" | "link" | "cta" | "secondary";
  linkLabel?: string;
  disabled?: boolean;
}

export function NewActivityModal({
  contactId,
  trigger = "pill",
  linkLabel = "Add",
  disabled = false,
}: NewActivityModalProps) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const [activityType, setActivityType] = useState<ActivityType>("note");
  const [title, setTitle] = useState("");
  const [occurredDate, setOccurredDate] = useState("");
  const panelRef = useRef<HTMLDivElement>(null);

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
    setActivityType("note");
    setTitle("");
    setOccurredDate("");
    setError(null);
  }

  function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
    const formData = new FormData(e.currentTarget);
    formData.set("contactId", contactId);
    formData.set("activityType", activityType);

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

  return (
    <>
      {trigger === "pill" || trigger === "cta" || trigger === "secondary" ? (
        <button
          type="button"
          className={`${trigger === "secondary" ? styles.btnSecondary : styles.btnPrimary} ${styles.btnPill}`}
          onClick={() => setOpen(true)}
          disabled={disabled || !contactId}
        >
          {trigger === "pill" ? (
            <>
              <IconPlus />
              New activity
            </>
          ) : trigger === "secondary" ? (
            <>
              <IconPlus />
              {linkLabel}
            </>
          ) : (
            linkLabel === "Add" ? "Add an Activity" : linkLabel
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

      {open && (
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
                  Log activity
                </h2>
                <p className={styles.modalSubtitle}>
                  Capture a note, call, email, or meeting on this record.
                </p>
              </div>
              <button
                type="button"
                className={styles.iconBtn}
                aria-label="Close"
                onClick={() => setOpen(false)}
                disabled={pending}
              >
                ×
              </button>
            </div>

            <form className={styles.modalBody} onSubmit={handleSubmit}>
              {error && <p className={styles.error}>{error}</p>}

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
                  placeholder="Left voicemail about listing"
                  required
                  disabled={pending}
                />
              </div>

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

              <div className={styles.field}>
                <label className={styles.label} htmlFor="new-activity-body">
                  Details
                </label>
                <textarea
                  id="new-activity-body"
                  name="body"
                  className={styles.input}
                  rows={3}
                  disabled={pending}
                  placeholder="Optional notes"
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
                  {pending ? "Saving…" : "Save activity"}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </>
  );
}
