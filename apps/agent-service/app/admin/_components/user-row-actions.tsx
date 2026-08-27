"use client";

import { useTransition } from "react";
import { useRouter } from "next/navigation";
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

  function handleDelete() {
    const confirmed = window.confirm(`Remove ${userName} from this account?`);
    if (!confirmed) return;

    const formData = new FormData();
    formData.set("tenantId", tenantId);
    formData.set("membershipId", membershipId);

    startTransition(async () => {
      const result = await deleteTenantUserAction(formData);
      if (!result.ok) {
        window.alert(result.error ?? "Could not delete user.");
        return;
      }
      router.refresh();
    });
  }

  return (
    <RowActionsMenu
      ariaLabel={`Actions for ${userName}`}
      disabled={pending}
      estimatedHeight={48}
    >
      <button
        type="button"
        className={`${styles.dropdownItem} ${styles.dropdownItemDanger}`}
        role="menuitem"
        onClick={handleDelete}
        disabled={pending}
      >
        Delete
      </button>
    </RowActionsMenu>
  );
}
