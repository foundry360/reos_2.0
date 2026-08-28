"use client";

import Link from "next/link";
import { useEffect, useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { UserRowActions } from "./user-row-actions";
import { UsersPagination } from "./users-pagination";
import { deleteTenantUsersAction } from "@/lib/admin/tenant-user-actions";
import type { TenantUserRole } from "@/lib/admin/tenant-users";
import type { UserRow } from "@/lib/admin/users-list";
import {
  buildSortHref,
  type UserSortColumn,
  type UsersListParams,
} from "@/lib/admin/users-list-params";
import { formatPhoneDisplay } from "@/lib/phone-display";
import { TableEmailCell, TablePhoneCell } from "@/components/shell/table-contact-cells";
import { UserAvatar } from "@/components/shell/user-avatar";
import styles from "@/components/shell/shell.module.css";

function UserTypeBadge({ role, label }: { role: TenantUserRole; label: string }) {
  const className =
    role === "owner" ? styles.badgeRole : role === "viewer" ? styles.badgeRoleMuted : styles.badgeActive;

  return <span className={`${styles.badge} ${className}`}>{label}</span>;
}

function IconSort({ direction }: { direction: "asc" | "desc" | null }) {
  const upOpacity = direction === "desc" ? 0.35 : direction === "asc" ? 1 : 0.55;
  const downOpacity = direction === "asc" ? 0.35 : direction === "desc" ? 1 : 0.55;

  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path
        d="M8 9l4-4 4 4"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        opacity={upOpacity}
      />
      <path
        d="M8 15l4 4 4-4"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        opacity={downOpacity}
      />
    </svg>
  );
}

function SortHeader({
  label,
  column,
  params,
}: {
  label: string;
  column: UserSortColumn;
  params: UsersListParams;
}) {
  const active = params.sort === column;
  const nextDir = active && params.dir === "asc" ? "descending" : "ascending";

  return (
    <div className={styles.tableSortHeader}>
      <span>{label}</span>
      <Link
        href={`/admin/users${buildSortHref(params, column)}`}
        className={`${styles.tableSortBtn} ${active ? styles.tableSortBtnActive : ""}`}
        aria-label={`Sort by ${label} ${nextDir}`}
      >
        <IconSort direction={active ? params.dir : null} />
      </Link>
    </div>
  );
}

interface UsersTableProps {
  rows: UserRow[];
  params: UsersListParams;
  total: number;
}

export function UsersTable({ rows, params, total }: UsersTableProps) {
  const router = useRouter();
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const rowIds = useMemo(() => rows.map((row) => row.membershipId), [rows]);

  useEffect(() => {
    setSelectedIds([]);
    setConfirmOpen(false);
    setError(null);
  }, [rowIds.join("|")]);

  const allSelected = rows.length > 0 && selectedIds.length === rows.length;
  const someSelected = selectedIds.length > 0 && !allSelected;

  function toggleAll() {
    setSelectedIds(allSelected ? [] : rows.map((row) => row.membershipId));
  }

  function toggleRow(id: string) {
    setSelectedIds((current) =>
      current.includes(id) ? current.filter((value) => value !== id) : [...current, id],
    );
  }

  function handleDelete() {
    setError(null);
    const items = rows
      .filter((row) => selectedIds.includes(row.membershipId))
      .map((row) => ({ tenantId: row.tenantId, membershipId: row.membershipId }));

    startTransition(async () => {
      const result = await deleteTenantUsersAction(items);
      if (!result.ok) {
        setError(result.error ?? "Could not delete users.");
        return;
      }
      setConfirmOpen(false);
      setSelectedIds([]);
      router.refresh();
    });
  }

  return (
    <>
      {selectedIds.length > 0 && (
        <div className={styles.bulkActionBar}>
          <span className={styles.bulkActionCount}>{selectedIds.length} selected</span>
          <button
            type="button"
            className={styles.btnDanger}
            onClick={() => {
              setError(null);
              setConfirmOpen(true);
            }}
            disabled={pending}
          >
            Delete
          </button>
          <button
            type="button"
            className={styles.btnSecondary}
            onClick={() => setSelectedIds([])}
            disabled={pending}
          >
            Clear
          </button>
        </div>
      )}

      <div className={`${styles.tableWrap} ${styles.tableWrapAllowMenuOverflow}`}>
        <table className={styles.table}>
          <thead>
            <tr>
              <th className={styles.tableSelectCol}>
                <input
                  type="checkbox"
                  checked={allSelected}
                  ref={(node) => {
                    if (node) node.indeterminate = someSelected;
                  }}
                  onChange={toggleAll}
                  aria-label="Select all users on this page"
                />
              </th>
              <th>
                <SortHeader label="Name" column="name" params={params} />
              </th>
              <th>Email</th>
              <th>
                <SortHeader label="Account" column="account" params={params} />
              </th>
              <th>
                <SortHeader label="User Type" column="role" params={params} />
              </th>
              <th>Phone</th>
              <th className={styles.tableActionCol} aria-label="Actions" />
            </tr>
          </thead>
          <tbody>
            {rows.map((user) => {
              const selected = selectedIds.includes(user.membershipId);
              return (
                <tr key={user.membershipId} data-selected={selected ? "true" : undefined}>
                  <td className={styles.tableSelectCol}>
                    <input
                      type="checkbox"
                      checked={selected}
                      onChange={() => toggleRow(user.membershipId)}
                      aria-label={`Select ${user.name}`}
                    />
                  </td>
                  <td>
                    <div className={styles.tableCellPerson}>
                      <UserAvatar
                        email={user.email}
                        displayName={user.name}
                        avatarUrl={user.avatarUrl}
                      />
                      <span className={styles.tableCellName}>{user.name}</span>
                    </div>
                  </td>
                  <td>
                    <TableEmailCell value={user.email} />
                  </td>
                  <td>
                    <Link
                      href={`/admin/accounts/${user.tenantId}`}
                      className={styles.tableCellLink}
                    >
                      {user.tenantName}
                    </Link>
                  </td>
                  <td>
                    <UserTypeBadge role={user.userType} label={user.userTypeLabel} />
                  </td>
                  <td>
                    <TablePhoneCell value={formatPhoneDisplay(user.phone)} />
                  </td>
                  <td className={`${styles.tableActionCol} ${styles.tableActionsCell}`}>
                    <UserRowActions
                      tenantId={user.tenantId}
                      membershipId={user.membershipId}
                      userName={user.name}
                    />
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
        <UsersPagination params={params} total={total} />
      </div>

      {confirmOpen && (
        <div className={styles.modalOverlay} onClick={() => !pending && setConfirmOpen(false)}>
          <div
            className={styles.modalPanel}
            role="dialog"
            aria-modal="true"
            aria-labelledby="delete-users-title"
            onClick={(e) => e.stopPropagation()}
          >
            <div className={styles.modalHeader}>
              <div>
                <h2 id="delete-users-title" className={styles.modalTitle}>
                  Remove {selectedIds.length} {selectedIds.length === 1 ? "user" : "users"}?
                </h2>
                <p className={styles.modalSubtitle}>
                  This removes the selected users from their accounts. This cannot be undone.
                </p>
              </div>
              <button
                type="button"
                className={styles.iconBtn}
                aria-label="Close"
                onClick={() => setConfirmOpen(false)}
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
                  onClick={() => setConfirmOpen(false)}
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
