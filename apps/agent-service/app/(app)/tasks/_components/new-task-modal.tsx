"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { createTaskAction } from "@/lib/crm/crm-actions";
import { DropdownSelect } from "@/components/shell/dropdown-select";
import { IconPlus } from "@/components/shell/sidebar-nav";
import styles from "@/components/shell/shell.module.css";

interface LeadOption {
  id: string;
  label: string;
}

interface NewTaskModalProps {
  leadOptions: LeadOption[];
  trigger?: "pill" | "link" | "cta";
  linkLabel?: string;
  disabled?: boolean;
}

export function NewTaskModal({
  leadOptions,
  trigger = "pill",
  linkLabel = "Add the first one",
  disabled = false,
}: NewTaskModalProps) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const [title, setTitle] = useState("");
  const [contactId, setContactId] = useState("none");
  const [dueDate, setDueDate] = useState("");
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
    setTitle("");
    setContactId("none");
    setDueDate("");
    setError(null);
  }

  function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
    const formData = new FormData(e.currentTarget);
    formData.set("contactId", contactId);

    startTransition(async () => {
      const result = await createTaskAction(formData);
      if (!result.ok) {
        setError(result.error ?? "Could not create task.");
        return;
      }
      resetForm();
      setOpen(false);
      router.refresh();
    });
  }

  const contactOptions = [
    { value: "none", label: "No linked lead" },
    ...leadOptions.map((lead) => ({ value: lead.id, label: lead.label })),
  ];

  return (
    <>
      {trigger === "pill" || trigger === "cta" ? (
        <button
          type="button"
          className={`${styles.btnPrimary} ${styles.btnPill}`}
          onClick={() => setOpen(true)}
          disabled={disabled}
        >
          {trigger === "pill" ? (
            <>
              <IconPlus />
              New task
            </>
          ) : (
            linkLabel === "Add the first one" ? "Add a Task" : linkLabel
          )}
        </button>
      ) : (
        <button
          type="button"
          className={styles.modalLinkTrigger}
          onClick={() => setOpen(true)}
          disabled={disabled}
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
            aria-labelledby="new-task-title"
            onClick={(e) => e.stopPropagation()}
          >
            <div className={styles.modalHeader}>
              <div>
                <h2 id="new-task-title" className={styles.modalTitle}>
                  New task
                </h2>
                <p className={styles.modalSubtitle}>
                  Create a follow-up or to-do for your team.
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
                <label className={styles.label} htmlFor="new-task-title-input">
                  Title
                </label>
                <input
                  id="new-task-title-input"
                  name="title"
                  className={styles.input}
                  value={title}
                  onChange={(e) => setTitle(e.target.value)}
                  placeholder="Call back about listing"
                  required
                  disabled={pending}
                />
              </div>

              <div className={styles.field}>
                <label className={styles.label} htmlFor="new-task-contact">
                  Lead
                </label>
                <DropdownSelect
                  id="new-task-contact"
                  value={contactId}
                  ariaLabel="Linked lead"
                  disabled={pending}
                  onChange={setContactId}
                  options={contactOptions}
                />
              </div>

              <div className={styles.field}>
                <label className={styles.label} htmlFor="new-task-due">
                  Due date
                </label>
                <input
                  id="new-task-due"
                  name="dueDate"
                  type="date"
                  className={styles.input}
                  value={dueDate}
                  onChange={(e) => setDueDate(e.target.value)}
                  disabled={pending}
                />
              </div>

              <div className={styles.field}>
                <label className={styles.label} htmlFor="new-task-notes">
                  Notes
                </label>
                <textarea
                  id="new-task-notes"
                  name="notes"
                  className={styles.input}
                  rows={3}
                  disabled={pending}
                  placeholder="Optional context"
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
                  {pending ? "Adding…" : "Add task"}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </>
  );
}
