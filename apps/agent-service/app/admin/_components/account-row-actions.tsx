"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { RowActionsMenu } from "@/components/shell/row-actions-menu";
import { deleteTenantAction } from "@/lib/admin/account-actions";
import { DeleteAccountModal } from "./delete-account-modal";
import styles from "@/components/shell/shell.module.css";

interface AccountRowActionsProps {
  accountId: string;
  accountName: string;
  className?: string;
  /** Stop drag activation when used on Kanban cards. */
  stopDrag?: boolean;
}

export function AccountRowActions({
  accountId,
  accountName,
  className,
  stopDrag = false,
}: AccountRowActionsProps) {
  const router = useRouter();
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function openDelete() {
    setError(null);
    setDeleteOpen(true);
  }

  function handleDelete() {
    setError(null);

    startTransition(async () => {
      const result = await deleteTenantAction(accountId);
      if (!result.ok) {
        setError(result.error ?? "Could not delete account.");
        return;
      }

      setDeleteOpen(false);
      router.push("/admin");
      router.refresh();
    });
  }

  const viewHref = `/admin/accounts/${accountId}`;
  const editHref = `/admin/accounts/${accountId}?tab=details`;

  return (
    <>
      <RowActionsMenu
        ariaLabel={`Actions for ${accountName}`}
        className={className}
        disabled={pending}
        stopDrag={stopDrag}
      >
        <Link
          href={viewHref}
          className={styles.dropdownItem}
          role="menuitem"
        >
          View
        </Link>
        <Link
          href={editHref}
          className={styles.dropdownItem}
          role="menuitem"
        >
          Edit
        </Link>
        <button
          type="button"
          className={`${styles.dropdownItem} ${styles.dropdownItemDanger}`}
          role="menuitem"
          onClick={openDelete}
        >
          Delete
        </button>
      </RowActionsMenu>

      <DeleteAccountModal
        open={deleteOpen}
        pending={pending}
        error={error}
        onClose={() => !pending && setDeleteOpen(false)}
        onConfirm={handleDelete}
      />
    </>
  );
}
