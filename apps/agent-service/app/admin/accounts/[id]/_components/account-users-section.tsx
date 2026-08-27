"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { RowActionsMenu } from "@/components/shell/row-actions-menu";
import { deleteTenantUserAction } from "@/lib/admin/tenant-user-actions";
import { displayValue } from "@/components/shell/inline-edit";
import { formatPhoneDisplay } from "@/lib/phone-display";
import { AccountAddUserModal } from "./account-add-user-modal";
import { AccountUserModal } from "./account-user-modal";
import { IconPlus } from "@/components/shell/sidebar-nav";
import { UserAvatar } from "@/components/shell/user-avatar";
import type { TenantUser, TenantUserRole } from "@/lib/admin/tenant-users";
import styles from "@/components/shell/shell.module.css";

interface AccountUsersSectionProps {
  tenantId: string;
  users: TenantUser[];
}

function UserTypeBadge({ role, label }: { role: TenantUserRole; label: string }) {
  const className =
    role === "owner" ? styles.badgeRole : role === "viewer" ? styles.badgeRoleMuted : styles.badgeActive;

  return <span className={`${styles.badge} ${className}`}>{label}</span>;
}

interface UserRowActionsProps {
  onEdit: () => void;
  onDelete: () => void;
  disabled?: boolean;
}

function UserRowActions({ onEdit, onDelete, disabled }: UserRowActionsProps) {
  return (
    <RowActionsMenu ariaLabel="User actions" disabled={disabled} estimatedHeight={88}>
      <button
        type="button"
        className={styles.dropdownItem}
        role="menuitem"
        onClick={onEdit}
      >
        Edit
      </button>
      <button
        type="button"
        className={`${styles.dropdownItem} ${styles.dropdownItemDanger}`}
        role="menuitem"
        onClick={onDelete}
      >
        Delete
      </button>
    </RowActionsMenu>
  );
}

export function AccountUsersSection({ tenantId, users }: AccountUsersSectionProps) {
  const router = useRouter();
  const [addingUser, setAddingUser] = useState(false);
  const [editingUser, setEditingUser] = useState<TenantUser | null>(null);
  const [pending, startTransition] = useTransition();

  function handleDelete(user: TenantUser) {
    const confirmed = window.confirm(`Remove ${user.name} from this account?`);
    if (!confirmed) return;

    const formData = new FormData();
    formData.set("tenantId", tenantId);
    formData.set("membershipId", user.membershipId);

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
    <>
      <div className={styles.usersSectionHeader}>
        <button
          type="button"
          className={`${styles.btnPrimary} ${styles.btnPill}`}
          onClick={() => setAddingUser(true)}
        >
          <IconPlus />
          Add user
        </button>
      </div>

      <div className={`${styles.tableWrap} ${styles.tableWrapAllowMenuOverflow}`}>
        <table className={styles.table}>
          <thead>
            <tr>
              <th>Name</th>
              <th>Email</th>
              <th>Phone</th>
              <th>User Type</th>
              <th className={styles.tableActionCol} aria-label="Actions" />
            </tr>
          </thead>
          <tbody>
            {users.length === 0 ? (
              <tr>
                <td colSpan={5} className={styles.tableEmptyCell}>
                  No users assigned to this account yet.
                </td>
              </tr>
            ) : (
              users.map((user) => (
                <tr key={user.membershipId}>
                  <td>
                    <div className={styles.tableCellPerson}>
                      <UserAvatar email={user.email} />
                      <span className={styles.tableCellName}>{user.name}</span>
                    </div>
                  </td>
                  <td>{user.email}</td>
                  <td>{formatPhoneDisplay(user.phone) ?? displayValue(null)}</td>
                  <td>
                    <UserTypeBadge role={user.userType} label={user.userTypeLabel} />
                  </td>
                  <td className={`${styles.tableActionCol} ${styles.tableActionsCell}`}>
                    <UserRowActions
                      disabled={pending}
                      onEdit={() => setEditingUser(user)}
                      onDelete={() => handleDelete(user)}
                    />
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      {addingUser && (
        <AccountAddUserModal tenantId={tenantId} onClose={() => setAddingUser(false)} />
      )}

      {editingUser && (
        <AccountUserModal
          tenantId={tenantId}
          user={editingUser}
          onClose={() => setEditingUser(null)}
        />
      )}
    </>
  );
}
