"use client";

import { useEffect, useRef, useState } from "react";
import styles from "@/components/shell/shell.module.css";

interface DeleteAccountModalProps {
  open: boolean;
  pending?: boolean;
  error?: string | null;
  onClose: () => void;
  onConfirm: () => void;
}

export function DeleteAccountModal({
  open,
  pending = false,
  error = null,
  onClose,
  onConfirm,
}: DeleteAccountModalProps) {
  const [confirmText, setConfirmText] = useState("");
  const panelRef = useRef<HTMLDivElement>(null);
  const canDelete = confirmText === "DELETE";

  useEffect(() => {
    if (!open) {
      setConfirmText("");
      return;
    }

    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape" && !pending) onClose();
    }

    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [open, pending, onClose]);

  useEffect(() => {
    if (open) {
      document.body.style.overflow = "hidden";
    } else {
      document.body.style.overflow = "";
    }

    return () => {
      document.body.style.overflow = "";
    };
  }, [open]);

  if (!open) return null;

  return (
    <div className={styles.modalOverlay} onClick={() => !pending && onClose()}>
      <div
        ref={panelRef}
        className={styles.modalPanel}
        role="dialog"
        aria-modal="true"
        aria-labelledby="delete-account-title"
        onClick={(e) => e.stopPropagation()}
      >
        <div className={styles.modalHeader}>
          <div>
            <h2 id="delete-account-title" className={styles.modalTitle}>
              Delete your account?
            </h2>
            <p className={styles.modalSubtitle}>
              This action is permanent and cannot be undone. Your account and all associated data
              will be permanently deleted.
            </p>
          </div>
          <button
            type="button"
            className={styles.iconBtn}
            aria-label="Close"
            onClick={onClose}
            disabled={pending}
          >
            ×
          </button>
        </div>

        <div className={styles.modalBody}>
          {error && <p className={styles.error}>{error}</p>}

          <p className={styles.modalConfirmHint}>To confirm, type DELETE below.</p>

          <div className={styles.field}>
            <label className={styles.label} htmlFor="delete-account-confirm">
              Confirmation
            </label>
            <input
              id="delete-account-confirm"
              className={styles.input}
              value={confirmText}
              onChange={(e) => setConfirmText(e.target.value)}
              placeholder="DELETE"
              autoComplete="off"
              disabled={pending}
            />
          </div>

          <div className={styles.modalFooter}>
            <button
              type="button"
              className={styles.btnSecondary}
              onClick={onClose}
              disabled={pending}
            >
              Cancel
            </button>
            <button
              type="button"
              className={styles.btnDanger}
              onClick={onConfirm}
              disabled={!canDelete || pending}
            >
              {pending ? "Deleting…" : "Delete"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
