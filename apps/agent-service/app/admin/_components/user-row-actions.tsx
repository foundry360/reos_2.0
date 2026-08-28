"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { RowActionsMenu } from "@/components/shell/row-actions-menu";
import { deleteTenantUserAction } from "@/lib/admin/tenant-user-actions";
import styles from "@/components/shell/shell.module.css";

interface UserRowActionsProps {
  tenantId: string;
  membershipId: string;
  userName: string;
}

export function UserRowActions({ tenantId, membershipId, userName }: UserRowActionsProps) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const viewHref = `/admin/accounts/${tenantId}`;
  const editHref = `/admin/accounts/${tenantId}?tab=users`;

  function handleDelete() {
    setError(null);
    const formData = new FormData();
    formData.set("tenantId", tenantId);
    formData.set("membershipId", membershipId);

    startTransition(async () => {
      const result = await deleteTenantUserAction(formData);
      if (!result.ok) {
        setError(result.error ?? "Could not delete user.");
        return;
      }
      setDeleteOpen(false);
      router.refresh();
    });
  }

  return (
    <>
      <RowActionsMenu
        ariaLabel={`Actions for ${userName}`}
        disabled={pending}
        estimatedHeight={132}
      >
        <Link href={viewHref} className={styles.dropdownItem} role="menuitem">
          View
        </Link>
        <Link href={editHref} className={styles.dropdownItem} role="menuitem">
          Edit
        </Link>
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

      {deleteOpen && (
        <div
          className={styles.modalOverlay}
          onClick={() => !pending && setDeleteOpen(false)}
        >
          <div
            className={styles.modalPanel}
            role="dialog"
            aria-modal="true"
            aria-labelledby="delete-user-title"
            onClick={(e) => e.stopPropagation()}
          >
            <div className={styles.modalHeader}>
              <div>
                <h2 id="delete-user-title" className={styles.modalTitle}>
                  Remove {userName}?
                </h2>
                <p className={styles.modalSubtitle}>
                  This removes the user from their account. This cannot be undone.
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
                  {pending ? "Removing…" : "Remove"}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
