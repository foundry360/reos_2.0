"use client";

import { useState, useTransition } from "react";
import { createPortal } from "react-dom";
import { useRouter } from "next/navigation";
import { RowActionsMenu } from "@/components/shell/row-actions-menu";
import { EditLeadModal } from "./edit-lead-modal";
import { deleteLeadsAction } from "@/lib/crm/crm-actions";
import {
  personBasePath,
  personSingular,
  type PersonKind,
} from "@/lib/crm/person-kind";
import type { LeadRow } from "@/lib/leads/leads-types";
import styles from "@/components/shell/shell.module.css";

interface LeadRowActionsProps {
  lead: LeadRow;
  kind?: PersonKind;
  stopDrag?: boolean;
}

export function LeadRowActions({ lead, kind = "lead", stopDrag = false }: LeadRowActionsProps) {
  const router = useRouter();
  const basePath = personBasePath(kind);
  const singular = personSingular(kind);
  const [editOpen, setEditOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function handleDelete() {
    setError(null);
    startTransition(async () => {
      const result = await deleteLeadsAction([lead.id]);
      if (!result.ok) {
        setError(result.error ?? `Could not delete ${singular}.`);
        return;
      }
      setDeleteOpen(false);
      router.refresh();
    });
  }

  return (
    <>
      <RowActionsMenu
        ariaLabel={`Actions for ${lead.name}`}
        disabled={pending}
        estimatedHeight={132}
        stopDrag={stopDrag}
      >
        <button
          type="button"
          className={styles.dropdownItem}
          role="menuitem"
          onClick={() => router.push(`${basePath}/${lead.id}`)}
        >
          View
        </button>
        <button
          type="button"
          className={styles.dropdownItem}
          role="menuitem"
          onClick={() => {
            // Defer until after the portaled menu closes so the opening click
            // cannot interact with the new overlay in the same event turn.
            window.setTimeout(() => setEditOpen(true), 0);
          }}
        >
          Edit
        </button>
        <button
          type="button"
          className={`${styles.dropdownItem} ${styles.dropdownItemDanger}`}
          role="menuitem"
          onClick={() => {
            setError(null);
            window.setTimeout(() => setDeleteOpen(true), 0);
          }}
        >
          Delete
        </button>
      </RowActionsMenu>

      {editOpen && (
        <EditLeadModal lead={lead} kind={kind} onClose={() => setEditOpen(false)} />
      )}

      {deleteOpen &&
        createPortal(
          <div
            className={styles.modalOverlay}
            onClick={() => !pending && setDeleteOpen(false)}
          >
            <div
              className={styles.modalPanel}
              role="dialog"
              aria-modal="true"
              aria-labelledby="delete-lead-title"
              onClick={(e) => e.stopPropagation()}
            >
              <div className={styles.modalHeader}>
                <div>
                  <h2 id="delete-lead-title" className={styles.modalTitle}>
                    Delete {lead.name}?
                  </h2>
                  <p className={styles.modalSubtitle}>
                    This permanently removes the {singular} and related messages. This cannot be
                    undone.
                  </p>
                </div>
                <button
                  type="button"
                  className={styles.iconBtn}
                  aria-label="Close"
                  onClick={() => setDeleteOpen(false)}
                  disabled={pending}
                >
                  ×
                </button>
              </div>
              <div className={styles.modalBody}>
                {error && <p className={styles.error}>{error}</p>}
                <div className={styles.modalFooter}>
                  <button
                    type="button"
                    className={styles.btnSecondary}
                    onClick={() => setDeleteOpen(false)}
                    disabled={pending}
                  >
                    Cancel
                  </button>
                  <button
                    type="button"
                    className={styles.btnDanger}
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
        )}
    </>
  );
}
