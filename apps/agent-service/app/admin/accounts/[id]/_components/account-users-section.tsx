"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
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

function IconMore() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <circle cx="5" cy="12" r="1.5" fill="currentColor" />
      <circle cx="12" cy="12" r="1.5" fill="currentColor" />
      <circle cx="19" cy="12" r="1.5" fill="currentColor" />
    </svg>
  );
}

function UserTypeBadge({ role, label }: { role: TenantUserRole; label: string }) {
  const className =
    role === "owner" ? styles.badgeRole : role === "viewer" ? styles.badgeRoleMuted : styles.badgeActive;

  return <span className={`${styles.badge} ${className}`}>{label}</span>;
}

interface RowActionsMenuProps {
  onEdit: () => void;
  onDelete: () => void;
  disabled?: boolean;
}

function RowActionsMenu({ onEdit, onDelete, disabled }: RowActionsMenuProps) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;

    function onDocClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }

    document.addEventListener("mousedown", onDocClick);
    return () => document.removeEventListener("mousedown", onDocClick);
  }, [open]);

  return (
    <div className={styles.rowActionsMenu} ref={ref}>
      <button
        type="button"
        className={styles.rowActionsBtn}
        aria-label="User actions"
        aria-expanded={open}
        aria-haspopup="menu"
        disabled={disabled}
        onClick={() => setOpen((value) => !value)}
      >
        <IconMore />
      </button>

      {open && (
        <div className={styles.rowActionsDropdown} role="menu">
          <button
            type="button"
            className={styles.dropdownItem}
            role="menuitem"
            onClick={() => {
              setOpen(false);
              onEdit();
            }}
          >
            Edit
          </button>
          <button
            type="button"
            className={`${styles.dropdownItem} ${styles.dropdownItemDanger}`}
            role="menuitem"
            onClick={() => {
              setOpen(false);
              onDelete();
            }}
          >
            Delete
          </button>
        </div>
      )}
    </div>
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

      <div className={styles.tableWrap}>
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
                  <td className={styles.tableActionCol}>
                    <RowActionsMenu
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
