"use client";

import { createPortal } from "react-dom";
import { useEffect, useState } from "react";
import shellStyles from "@/components/shell/shell.module.css";

interface LeaveJourneyModalProps {
  open: boolean;
  onStay: () => void;
  onLeave: () => void;
}

export function LeaveJourneyModal({ open, onStay, onLeave }: LeaveJourneyModalProps) {
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setMounted(true);
  }, []);

  useEffect(() => {
    if (!open) return;
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") onStay();
    }
    document.addEventListener("keydown", onKeyDown);
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      document.body.style.overflow = "";
    };
  }, [open, onStay]);

  if (!open || !mounted) return null;

  return createPortal(
    <div className={shellStyles.modalOverlay} onClick={onStay}>
      <div
        className={shellStyles.modalPanel}
        role="dialog"
        aria-modal="true"
        aria-labelledby="leave-journey-title"
        onClick={(e) => e.stopPropagation()}
      >
        <div className={shellStyles.modalHeader}>
          <div>
            <h2 id="leave-journey-title" className={shellStyles.modalTitle}>
              Leave without saving?
            </h2>
            <p className={shellStyles.modalSubtitle}>
              You have unsaved changes to this journey. They&apos;ll be lost if you leave.
            </p>
          </div>
          <button type="button" className={shellStyles.iconBtn} aria-label="Close" onClick={onStay}>
            ×
          </button>
        </div>
        <div className={shellStyles.modalBody}>
          <div className={shellStyles.modalFooter}>
            <button type="button" className={shellStyles.btnSecondary} onClick={onStay} autoFocus>
              Keep editing
            </button>
            <button type="button" className={shellStyles.btnDanger} onClick={onLeave}>
              Leave
            </button>
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
}
