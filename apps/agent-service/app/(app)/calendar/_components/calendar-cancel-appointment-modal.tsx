"use client";

import { createPortal } from "react-dom";
import { useRouter } from "next/navigation";
import { useEffect, useState, useTransition } from "react";
import type { CalendarEvent } from "@/lib/calendar/calendar-types";
import { cancelCalendarAppointmentAction } from "@/lib/crm/crm-actions";
import shellStyles from "@/components/shell/shell.module.css";

interface CalendarCancelAppointmentModalProps {
  event: CalendarEvent;
  open: boolean;
  onClose: () => void;
  onCancelled?: () => void;
}

export function CalendarCancelAppointmentModal({
  event,
  open,
  onClose,
  onCancelled,
}: CalendarCancelAppointmentModalProps) {
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

  function handleCancel() {
    if (pending) return;
    startTransition(async () => {
      const result = await cancelCalendarAppointmentAction(event.id);
      if (!result.ok) {
        setError(result.error ?? "Could not cancel appointment.");
        return;
      }
      onClose();
      onCancelled?.();
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
        aria-labelledby="cancel-appointment-title"
        onClick={(e) => e.stopPropagation()}
      >
        <div className={shellStyles.modalHeader}>
          <div>
            <h2 id="cancel-appointment-title" className={shellStyles.modalTitle}>
              Cancel {event.title}?
            </h2>
            <p className={shellStyles.modalSubtitle}>
              This removes the appointment from the calendar and sends a cancellation to anyone who got the
              invite. The appointment stays in the activity history. This cannot be undone.
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
              Keep appointment
            </button>
            <button
              type="button"
              className={shellStyles.btnDanger}
              onClick={handleCancel}
              disabled={pending}
            >
              {pending ? "Cancelling…" : "Cancel appointment"}
            </button>
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
}
