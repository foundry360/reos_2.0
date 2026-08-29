"use client";

import { useEffect, useRef, useState } from "react";
import styles from "@/components/shell/shell.module.css";

interface ConnectStripeModalProps {
  open: boolean;
  pending?: boolean;
  error?: string | null;
  onClose: () => void;
  onConfirm: (stripeCustomerId: string) => void;
}

export function ConnectStripeModal({
  open,
  pending = false,
  error = null,
  onClose,
  onConfirm,
}: ConnectStripeModalProps) {
  const [stripeCustomerId, setStripeCustomerId] = useState("");
  const panelRef = useRef<HTMLDivElement>(null);
  const canConnect = stripeCustomerId.trim().length > 0;

  useEffect(() => {
    if (!open) {
      setStripeCustomerId("");
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
        aria-labelledby="connect-stripe-title"
        onClick={(e) => e.stopPropagation()}
      >
        <div className={styles.modalHeader}>
          <div>
            <h2 id="connect-stripe-title" className={styles.modalTitle}>
              Link Stripe customer
            </h2>
            <p className={styles.modalSubtitle}>
              Enter the Stripe customer ID (cus_...) to link this account for usage billing.
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

          <div className={styles.field}>
            <label className={styles.label} htmlFor="connect-stripe-customer-id">
              Stripe customer ID
            </label>
            <input
              id="connect-stripe-customer-id"
              className={styles.input}
              value={stripeCustomerId}
              onChange={(e) => setStripeCustomerId(e.target.value)}
              placeholder="cus_..."
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
              className={styles.btnPrimary}
              onClick={() => onConfirm(stripeCustomerId.trim())}
              disabled={!canConnect || pending}
            >
              {pending ? "Linking…" : "Link Customer"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
