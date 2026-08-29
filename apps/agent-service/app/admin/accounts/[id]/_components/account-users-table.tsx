"use client";

import { useEffect, useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { RowActionsMenu } from "@/components/shell/row-actions-menu";
import { deleteTenantUsersAction } from "@/lib/admin/tenant-user-actions";
import type { TenantUser, TenantUserRole } from "@/lib/admin/tenant-users";
import { formatPhoneDisplay } from "@/lib/phone-display";
import { TableEmailCell, TablePhoneCell } from "@/components/shell/table-contact-cells";
import { AccountAddUserModal } from "./account-add-user-modal";
import { AccountUserModal } from "./account-user-modal";
import { IconPlus } from "@/components/shell/sidebar-nav";
import { UserAvatar } from "@/components/shell/user-avatar";
import { DropdownSelect } from "@/components/shell/dropdown-select";
import { PAGE_SIZES } from "@/lib/admin/accounts-list-params";
import { ClientAdminLayoutToggle, type AdminLayout } from "../../../_components/admin-layout-toggle";
import styles from "@/components/shell/shell.module.css";

function UserTypeBadge({ role, label }: { role: TenantUserRole; label: string }) {
  const className =
    role === "owner" ? styles.badgeRole : role === "viewer" ? styles.badgeRoleMuted : styles.badgeActive;

  return <span className={`${styles.badge} ${className}`}>{label}</span>;
}

function csvEscape(value: string): string {
  if (/[",\n]/.test(value)) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

interface AccountUsersTableProps {
  tenantId: string;
  users: TenantUser[];
}

export function AccountUsersTable({ tenantId, users }: AccountUsersTableProps) {
  const router = useRouter();
  const [addingUser, setAddingUser] = useState(false);
  const [editingUser, setEditingUser] = useState<TenantUser | null>(null);
  const [layout, setLayout] = useState<AdminLayout>("list");
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(1);
  const [perPage, setPerPage] = useState<(typeof PAGE_SIZES)[number]>(25);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const filtered = useMemo(() => {
    const term = search.trim().toLowerCase();
    if (!term) return users;
    return users.filter(
      (user) =>
        user.name.toLowerCase().includes(term) ||
        user.email.toLowerCase().includes(term) ||
        (user.phone ?? "").includes(term),
    );
  }, [users, search]);

  const rowIds = useMemo(() => filtered.map((user) => user.membershipId), [filtered]);

  useEffect(() => {
    setSelectedIds([]);
    setConfirmOpen(false);
    setError(null);
  }, [rowIds.join("|")]);

  const totalPages = Math.max(1, Math.ceil(filtered.length / perPage));
  const safePage = Math.min(page, totalPages);
  const from = filtered.length === 0 ? 0 : (safePage - 1) * perPage + 1;
  const to = Math.min(safePage * perPage, filtered.length);
  const pageRows = filtered.slice((safePage - 1) * perPage, safePage * perPage);

  const kanbanColumns = useMemo(() => {
    const roles: TenantUserRole[] = ["owner", "agent", "viewer"];
    return roles.reduce(
      (acc, role) => {
        acc[role] = filtered.filter((user) => user.userType === role);
        return acc;
      },
      { owner: [], agent: [], viewer: [] } as Record<TenantUserRole, TenantUser[]>,
    );
  }, [filtered]);

  const roleLabels: Record<TenantUserRole, string> = {
    owner: "Owner",
    agent: "Agent",
    viewer: "Viewer",
  };

  const allSelected = pageRows.length > 0 && selectedIds.length === pageRows.length;
  const someSelected = selectedIds.length > 0 && !allSelected;

  function toggleAll() {
    setSelectedIds(allSelected ? [] : pageRows.map((user) => user.membershipId));
  }

  function toggleRow(id: string) {
    setSelectedIds((current) =>
      current.includes(id) ? current.filter((value) => value !== id) : [...current, id],
    );
  }

  function handleBulkDelete() {
    setError(null);
    const items = users
      .filter((user) => selectedIds.includes(user.membershipId))
      .map((user) => ({ tenantId, membershipId: user.membershipId }));

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

  function handleDelete(user: TenantUser) {
    setError(null);
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

  function exportCsv() {
    const header = ["Name", "Email", "Phone", "User Type"];
    const lines = [
      header.join(","),
      ...filtered.map((user) =>
        [
          csvEscape(user.name),
          csvEscape(user.email),
          csvEscape(user.phone ?? ""),
          csvEscape(user.userTypeLabel),
        ].join(","),
      ),
    ];
    const blob = new Blob([`${lines.join("\n")}\n`], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `account-users-${new Date().toISOString().slice(0, 10)}.csv`;
    anchor.click();
    URL.revokeObjectURL(url);
  }

  return (
    <>
      <div className={styles.usersSectionHeader}>
        <div className={styles.pageHeaderActions}>
          <ClientAdminLayoutToggle layout={layout} onChange={setLayout} />
          <input
            type="search"
            className={styles.input}
            placeholder="Search users"
            value={search}
            onChange={(e) => {
              setSearch(e.target.value);
              setPage(1);
            }}
            aria-label="Search account users"
          />
          <button
            type="button"
            className={`${styles.btnSecondary} ${styles.btnPill}`}
            onClick={exportCsv}
          >
            Export
          </button>
        </div>
        <button
          type="button"
          className={`${styles.btnPrimary} ${styles.btnPill}`}
          onClick={() => setAddingUser(true)}
        >
          <IconPlus />
          Add User
        </button>
      </div>

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

      {layout === "kanban" ? (
        <div className={`${styles.kanbanBoard} kanban-board-scroll`}>
          {(["owner", "agent", "viewer"] as TenantUserRole[]).map((role) => (
            <section key={role} className={styles.kanbanColumn}>
              <header className={styles.kanbanColumnHeader}>
                <h2 className={styles.kanbanColumnTitle}>{roleLabels[role]}</h2>
                <span className={styles.kanbanColumnCount}>{kanbanColumns[role].length}</span>
              </header>
              <div className={`${styles.kanbanColumnBody} kanban-column-scroll`}>
                {kanbanColumns[role].length === 0 ? (
                  <p className={styles.kanbanEmpty}>No users</p>
                ) : (
                  kanbanColumns[role].map((user) => (
                    <div key={user.membershipId} className={styles.kanbanCard}>
                      <div className={styles.tableCellPerson}>
                        <UserAvatar email={user.email} displayName={user.name} />
                        <strong className={styles.kanbanCardTitle}>{user.name}</strong>
                      </div>
                      <div className={styles.kanbanCardContact}>
                        <span className={styles.kanbanCardContactText}>{user.email}</span>
                        {(formatPhoneDisplay(user.phone) ?? null) && (
                          <span className={styles.kanbanCardContactText}>
                            {formatPhoneDisplay(user.phone)}
                          </span>
                        )}
                      </div>
                      <div className={styles.kanbanCardFooter}>
                        <button
                          type="button"
                          className={styles.tableFooterLink}
                          onClick={() => setEditingUser(user)}
                        >
                          Edit
                        </button>
                      </div>
                    </div>
                  ))
                )}
              </div>
            </section>
          ))}
        </div>
      ) : (
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
                  disabled={pageRows.length === 0}
                />
              </th>
              <th>Name</th>
              <th>Email</th>
              <th>Phone</th>
              <th>User Type</th>
              <th className={styles.tableActionCol} aria-label="Actions" />
            </tr>
          </thead>
          <tbody>
            {pageRows.length === 0 ? (
              <tr>
                <td colSpan={6} className={styles.tableEmptyCell}>
                  {search ? "No users match your search." : "No users assigned to this account yet."}
                </td>
              </tr>
            ) : (
              pageRows.map((user) => {
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
                        <UserAvatar email={user.email} displayName={user.name} />
                        <span className={styles.tableCellName}>{user.name}</span>
                      </div>
                    </td>
                    <td>
                      <TableEmailCell value={user.email} />
                    </td>
                    <td>
                      <TablePhoneCell value={formatPhoneDisplay(user.phone)} />
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
                );
              })
            )}
          </tbody>
        </table>

        {filtered.length > 0 && (
          <div className={styles.tableFooter}>
            <div className={styles.tableFooterMeta}>
              <span>
                <strong>
                  {from} to {to}
                </strong>{" "}
                items of {filtered.length}
              </span>
              <label className={styles.tableFooterPerPage} htmlFor="account-users-per-page">
                <span>Rows</span>
                <DropdownSelect
                  id="account-users-per-page"
                  value={String(perPage)}
                  variant="compact"
                  ariaLabel="Rows per page"
                  onChange={(value) => {
                    setPerPage(Number(value) as (typeof PAGE_SIZES)[number]);
                    setPage(1);
                  }}
                  options={PAGE_SIZES.map((size) => ({
                    value: String(size),
                    label: String(size),
                  }))}
                />
              </label>
            </div>
            <div className={styles.tableFooterNav}>
              <button
                type="button"
                className={styles.tableFooterLink}
                disabled={safePage <= 1}
                onClick={() => setPage(safePage - 1)}
              >
                &lt; Previous
              </button>
              <button
                type="button"
                className={styles.tableFooterLink}
                disabled={safePage >= totalPages}
                onClick={() => setPage(safePage + 1)}
              >
                Next &gt;
              </button>
            </div>
          </div>
        )}
      </div>
      )}

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

      {confirmOpen && (
        <div className={styles.modalOverlay} onClick={() => !pending && setConfirmOpen(false)}>
          <div
            className={styles.modalPanel}
            role="dialog"
            aria-modal="true"
            aria-labelledby="delete-account-users-title"
            onClick={(e) => e.stopPropagation()}
          >
            <div className={styles.modalHeader}>
              <div>
                <h2 id="delete-account-users-title" className={styles.modalTitle}>
                  Remove {selectedIds.length} {selectedIds.length === 1 ? "user" : "users"}?
                </h2>
                <p className={styles.modalSubtitle}>
                  This removes the selected users from this account. This cannot be undone.
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
                  onClick={handleBulkDelete}
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
