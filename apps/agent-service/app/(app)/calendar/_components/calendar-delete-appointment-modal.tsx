"use client";

import { createPortal } from "react-dom";
import { useRouter } from "next/navigation";
import { useEffect, useState, useTransition } from "react";
import type { CalendarEvent } from "@/lib/calendar/calendar-types";
import { deleteCalendarAppointmentAction } from "@/lib/crm/crm-actions";
import shellStyles from "@/components/shell/shell.module.css";

interface CalendarDeleteAppointmentModalProps {
  event: CalendarEvent;
  open: boolean;
  onClose: () => void;
  onDeleted?: () => void;
}

export function CalendarDeleteAppointmentModal({
  event,
  open,
  onClose,
  onDeleted,
}: CalendarDeleteAppointmentModalProps) {
  const router = useRouter();
  const [mounted, setMounted] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  useEffect(() => {
    setMounted(true);
  }, []);

  useEffect(() => {
    if (!open) return;
    setError(null);
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape" && !pending) onClose();
    }
    document.addEventListener("keydown", onKeyDown);
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      document.body.style.overflow = "";
    };
  }, [open, pending, onClose]);

  function handleDelete() {
    if (pending) return;
    startTransition(async () => {
      const result = await deleteCalendarAppointmentAction(event.id);
      if (!result.ok) {
        setError(result.error ?? "Could not remove appointment.");
        return;
      }
      onClose();
      onDeleted?.();
      router.refresh();
    });
  }

  if (!open || !mounted) return null;

  return createPortal(
    <div
      className={shellStyles.modalOverlay}
      onClick={() => !pending && onClose()}
    >
      <div
        className={shellStyles.modalPanel}
        role="dialog"
        aria-modal="true"
        aria-labelledby="delete-appointment-title"
        onClick={(e) => e.stopPropagation()}
      >
        <div className={shellStyles.modalHeader}>
          <div>
            <h2 id="delete-appointment-title" className={shellStyles.modalTitle}>
              Delete {event.title}?
            </h2>
            <p className={shellStyles.modalSubtitle}>
              This removes the appointment from the calendar. This cannot be undone.
            </p>
          </div>
          <button
            type="button"
            className={shellStyles.iconBtn}
            aria-label="Close"
            onClick={onClose}
            disabled={pending}
          >
            ×
          </button>
        </div>
        <div className={shellStyles.modalBody}>
          {error ? <p className={shellStyles.error}>{error}</p> : null}
          <div className={shellStyles.modalFooter}>
            <button
              type="button"
              className={shellStyles.btnSecondary}
              onClick={onClose}
              disabled={pending}
            >
              Cancel
            </button>
            <button
              type="button"
              className={shellStyles.btnDanger}
              onClick={handleDelete}
              disabled={pending}
            >
              {pending ? "Deleting…" : "Delete"}
            </button>
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
}
