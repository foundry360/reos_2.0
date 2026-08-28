"use client";

import { useEffect } from "react";
import { createPortal } from "react-dom";
import { personSingularTitle, type PersonKind } from "@/lib/crm/person-kind";
import styles from "@/components/shell/shell.module.css";

interface PersonActivityModalProps {
  personName: string;
  kind?: PersonKind;
  onClose: () => void;
}

export function PersonActivityModal({
  personName,
  kind = "lead",
  onClose,
}: PersonActivityModalProps) {
  const singularTitle = personSingularTitle(kind);

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }

    document.addEventListener("keydown", onKeyDown);
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      document.body.style.overflow = "";
    };
  }, [onClose]);

  return createPortal(
    <div className={styles.modalOverlay} onClick={onClose}>
      <div
        className={`${styles.modalPanel} ${styles.activityModalPanel}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby="person-activity-title"
        onClick={(e) => e.stopPropagation()}
      >
        <div className={styles.modalHeader}>
          <div>
            <h2 id="person-activity-title" className={styles.modalTitle}>
              Activity · {personName}
            </h2>
            <p className={styles.modalSubtitle}>
              Timeline and notes for this {singularTitle.toLowerCase()}
            </p>
          </div>
          <button
            type="button"
            className={styles.iconBtn}
            aria-label="Close"
            onClick={onClose}
          >
            ×
          </button>
        </div>

        <div className={styles.activityModalBody}>
          <section className={styles.activityModalColumn} aria-label="Activity timeline">
            <h3 className={styles.activityModalColumnTitle}>Timeline</h3>
            <div className={styles.activityModalPlaceholder}>
              <p className={styles.activityModalPlaceholderTitle}>No activity yet</p>
              <p className={styles.activityModalPlaceholderText}>
                Calls, emails, notes, and status changes will show up here. Coming soon.
              </p>
            </div>
          </section>

          <section className={styles.activityModalColumn} aria-label="Add activity">
            <h3 className={styles.activityModalColumnTitle}>Add activity</h3>
            <div className={styles.activityModalPlaceholder}>
              <p className={styles.activityModalPlaceholderTitle}>Log a new activity</p>
              <p className={styles.activityModalPlaceholderText}>
                Add notes, calls, and follow-ups from here. Coming soon.
              </p>
              <button type="button" className={styles.btnSecondary} disabled>
                Add activity
              </button>
            </div>
          </section>
        </div>
      </div>
    </div>,
    document.body,
  );
}
