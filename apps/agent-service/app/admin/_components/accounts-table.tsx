"use client";

import Link from "next/link";
import { useEffect, useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { AccountRowActions } from "./account-row-actions";
import { AccountsPagination } from "./accounts-pagination";
import { deleteTenantsAction } from "@/lib/admin/account-actions";
import { AccountStatusBadge } from "@/lib/admin/account-status";
import type { AccountRow } from "@/lib/admin/accounts-list";
import {
  buildSortHref,
  type AccountSortColumn,
  type AccountsListParams,
} from "@/lib/admin/accounts-list-params";
import { formatPhoneDisplay } from "@/lib/phone-display";
import { accountInitials } from "@/lib/user-display";
import styles from "@/components/shell/shell.module.css";

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
  column: AccountSortColumn;
  params: AccountsListParams;
}) {
  const active = params.sort === column;
  const nextDir = active && params.dir === "asc" ? "descending" : "ascending";

  return (
    <div className={styles.tableSortHeader}>
      <span>{label}</span>
      <Link
        href={`/admin${buildSortHref(params, column)}`}
        className={`${styles.tableSortBtn} ${active ? styles.tableSortBtnActive : ""}`}
        aria-label={`Sort by ${label} ${nextDir}`}
      >
        <IconSort direction={active ? params.dir : null} />
      </Link>
    </div>
  );
}

interface AccountsTableProps {
  rows: AccountRow[];
  params: AccountsListParams;
  total: number;
}

export function AccountsTable({ rows, params, total }: AccountsTableProps) {
  const router = useRouter();
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const rowIds = useMemo(() => rows.map((row) => row.id), [rows]);

  useEffect(() => {
    setSelectedIds([]);
    setConfirmOpen(false);
    setError(null);
  }, [rowIds.join("|")]);

  const allSelected = rows.length > 0 && selectedIds.length === rows.length;
  const someSelected = selectedIds.length > 0 && !allSelected;

  function toggleAll() {
    setSelectedIds(allSelected ? [] : rows.map((row) => row.id));
  }

  function toggleRow(id: string) {
    setSelectedIds((current) =>
      current.includes(id) ? current.filter((value) => value !== id) : [...current, id],
    );
  }

  function handleDelete() {
    setError(null);
    startTransition(async () => {
      const result = await deleteTenantsAction(selectedIds);
      if (!result.ok) {
        setError(result.error ?? "Could not delete accounts.");
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
                  aria-label="Select all accounts on this page"
                />
              </th>
              <th>
                <SortHeader label="Name" column="name" params={params} />
              </th>
              <th>
                <SortHeader label="Account Name" column="slug" params={params} />
              </th>
              <th>
                <SortHeader label="Status" column="status" params={params} />
              </th>
              <th>Phone</th>
              <th>Email</th>
              <th>
                <SortHeader label="Timezone" column="timezone" params={params} />
              </th>
              <th className={styles.tableActionCol} aria-label="Actions" />
            </tr>
          </thead>
          <tbody>
            {rows.map((tenant) => {
              const selected = selectedIds.includes(tenant.id);
              return (
                <tr key={tenant.id} data-selected={selected ? "true" : undefined}>
                  <td className={styles.tableSelectCol}>
                    <input
                      type="checkbox"
                      checked={selected}
                      onChange={() => toggleRow(tenant.id)}
                      aria-label={`Select ${tenant.name}`}
                    />
                  </td>
                  <td>
                    <div className={styles.tableCellPerson}>
                      <span className={styles.avatar}>{accountInitials(tenant.name)}</span>
                      <Link
                        href={`/admin/accounts/${tenant.id}`}
                        className={styles.tableCellLink}
                      >
                        <span className={styles.tableCellName}>{tenant.name}</span>
                      </Link>
                    </div>
                  </td>
                  <td>{tenant.slug}</td>
                  <td>
                    <AccountStatusBadge status={tenant.status} />
                  </td>
                  <td>{formatPhoneDisplay(tenant.phone) ?? "None"}</td>
                  <td>{tenant.email ?? "None"}</td>
                  <td>{tenant.timezone.replace("_", " ")}</td>
                  <td className={`${styles.tableActionCol} ${styles.tableActionsCell}`}>
                    <AccountRowActions accountId={tenant.id} accountName={tenant.name} />
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
        <AccountsPagination params={params} total={total} />
      </div>

      {confirmOpen && (
        <div className={styles.modalOverlay} onClick={() => !pending && setConfirmOpen(false)}>
          <div
            className={styles.modalPanel}
            role="dialog"
            aria-modal="true"
            aria-labelledby="delete-accounts-title"
            onClick={(e) => e.stopPropagation()}
          >
            <div className={styles.modalHeader}>
              <div>
                <h2 id="delete-accounts-title" className={styles.modalTitle}>
                  Delete {selectedIds.length}{" "}
                  {selectedIds.length === 1 ? "account" : "accounts"}?
                </h2>
                <p className={styles.modalSubtitle}>
                  This permanently removes the selected accounts and related data. This cannot be
                  undone.
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
                  {pending ? "Deleting…" : "Delete"}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
