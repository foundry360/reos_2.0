"use client";

import { useState, useTransition } from "react";
import { createPortal } from "react-dom";
import { useRouter } from "next/navigation";
import { RowActionsMenu } from "@/components/shell/row-actions-menu";
import { EditOpportunityModal } from "./edit-opportunity-modal";
import { deleteOpportunitiesAction } from "@/lib/crm/crm-actions";
import type { OpportunityRow } from "@/lib/opportunities/opportunities-types";
import styles from "@/components/shell/shell.module.css";

interface SelectOption {
  id: string;
  label: string;
}

interface OpportunityRowActionsProps {
  opportunity: OpportunityRow;
  contactOptions: SelectOption[];
  agentOptions: SelectOption[];
  stopDrag?: boolean;
}

export function OpportunityRowActions({
  opportunity,
  contactOptions,
  agentOptions,
  stopDrag = false,
}: OpportunityRowActionsProps) {
  const router = useRouter();
  const [editOpen, setEditOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function handleDelete() {
    setError(null);
    startTransition(async () => {
      const result = await deleteOpportunitiesAction([opportunity.id]);
      if (!result.ok) {
        setError(result.error ?? "Could not delete opportunity.");
        return;
      }
      setDeleteOpen(false);
      router.refresh();
    });
  }

  return (
    <>
      <RowActionsMenu
        ariaLabel={`Actions for ${opportunity.name}`}
        disabled={pending}
        estimatedHeight={96}
        stopDrag={stopDrag}
      >
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
        <EditOpportunityModal
          opportunity={opportunity}
          contactOptions={contactOptions}
          agentOptions={agentOptions}
          onClose={() => setEditOpen(false)}
        />
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
              aria-labelledby="delete-opportunity-title"
              onClick={(e) => e.stopPropagation()}
            >
              <div className={styles.modalHeader}>
                <div>
                  <h2 id="delete-opportunity-title" className={styles.modalTitle}>
                    Delete {opportunity.name}?
                  </h2>
                  <p className={styles.modalSubtitle}>
                    This permanently removes the opportunity. This cannot be undone.
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
