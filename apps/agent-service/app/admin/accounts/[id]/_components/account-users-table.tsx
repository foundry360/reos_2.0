"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { RowActionsMenu } from "@/components/shell/row-actions-menu";
import { deleteTenantUsersAction } from "@/lib/admin/tenant-user-actions";
import type { TenantUser, TenantUserRole } from "@/lib/admin/tenant-users";
import { TableEmailCell } from "@/components/shell/table-contact-cells";
import { AccountAddUserModal } from "./account-add-user-modal";
import { AccountUserModal } from "./account-user-modal";
import { IconPlus } from "@/components/shell/sidebar-nav";
import { UserAvatar } from "@/components/shell/user-avatar";
import styles from "@/components/shell/shell.module.css";

function UserTypeBadge({ role, label }: { role: TenantUserRole; label: string }) {
  const className =
    role === "owner" ? styles.badgeRole : role === "viewer" ? styles.badgeRoleMuted : styles.badgeActive;

  return <span className={`${styles.badge} ${className}`}>{label}</span>;
}

interface AccountUsersTableProps {
  tenantId: string;
  users: TenantUser[];
}

export function AccountUsersTable({ tenantId, users }: AccountUsersTableProps) {
  const router = useRouter();
  const [addingUser, setAddingUser] = useState(false);
  const [editingUser, setEditingUser] = useState<TenantUser | null>(null);
  const [pending, startTransition] = useTransition();

  function handleDelete(user: TenantUser) {
    startTransition(async () => {
      const result = await deleteTenantUsersAction([
        { tenantId, membershipId: user.membershipId },
      ]);
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
          Add User
        </button>
      </div>

      <div className={`${styles.tableWrap} ${styles.tableWrapAllowMenuOverflow}`}>
        <table className={styles.table}>
          <thead>
            <tr>
              <th>Name</th>
              <th>Email</th>
              <th>User Type</th>
              <th className={styles.tableActionCol} aria-label="Actions" />
            </tr>
          </thead>
          <tbody>
            {users.length === 0 ? (
              <tr>
                <td colSpan={4} className={styles.tableEmptyCell}>
                  No users assigned to this account yet.
                </td>
              </tr>
            ) : (
              users.map((user) => (
                <tr key={user.membershipId}>
                  <td>
                    <div className={styles.tableCellPerson}>
                      <UserAvatar email={user.email} displayName={user.name} />
                      <span className={styles.tableCellName}>{user.name}</span>
                    </div>
                  </td>
                  <td>
                    <TableEmailCell value={user.email} />
                  </td>
                  <td>
                    <UserTypeBadge role={user.userType} label={user.userTypeLabel} />
                  </td>
                  <td className={`${styles.tableActionCol} ${styles.tableActionsCell}`}>
                    <RowActionsMenu
                      ariaLabel={`Actions for ${user.name}`}
                      disabled={pending}
                      estimatedHeight={88}
                    >
                      <button
                        type="button"
                        className={styles.dropdownItem}
                        role="menuitem"
                        onClick={() => setEditingUser(user)}
                      >
                        Edit
                      </button>
                      <button
                        type="button"
                        className={`${styles.dropdownItem} ${styles.dropdownItemDanger}`}
                        role="menuitem"
                        onClick={() => handleDelete(user)}
                      >
                        Delete
                      </button>
                    </RowActionsMenu>
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
