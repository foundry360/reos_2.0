"use client";

import { useEffect, useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import {
  removePlatformAdminsAction,
  type PlatformAdminRow,
} from "@/lib/admin/platform-admin-actions";
import { ClientAdminLayoutToggle, type AdminLayout } from "../../_components/admin-layout-toggle";
import { RowActionsMenu } from "@/components/shell/row-actions-menu";
import { UserAvatar } from "@/components/shell/user-avatar";
import { DropdownSelect } from "@/components/shell/dropdown-select";
import { PAGE_SIZES } from "@/lib/admin/accounts-list-params";
import styles from "@/components/shell/shell.module.css";

type SortColumn = "name" | "email" | "added";
type SortDir = "asc" | "desc";

function csvEscape(value: string): string {
  if (/[",\n]/.test(value)) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

function IconSort({ direction }: { direction: SortDir | null }) {
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

interface PlatformAdminsTableProps {
  admins: PlatformAdminRow[];
  currentUserId: string;
}

export function PlatformAdminsTable({ admins, currentUserId }: PlatformAdminsTableProps) {
  const router = useRouter();
  const [layout, setLayout] = useState<AdminLayout>("list");
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(1);
  const [perPage, setPerPage] = useState<(typeof PAGE_SIZES)[number]>(25);
  const [sort, setSort] = useState<SortColumn>("added");
  const [dir, setDir] = useState<SortDir>("asc");
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const filtered = useMemo(() => {
    const term = search.trim().toLowerCase();
    let rows = admins;
    if (term) {
      rows = rows.filter(
        (admin) =>
          admin.displayName.toLowerCase().includes(term) ||
          admin.email.toLowerCase().includes(term),
      );
    }

    const sorted = [...rows].sort((a, b) => {
      let cmp = 0;
      if (sort === "name") {
        cmp = a.displayName.localeCompare(b.displayName);
      } else if (sort === "email") {
        cmp = a.email.localeCompare(b.email);
      } else {
        cmp = new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime();
      }
      return dir === "asc" ? cmp : -cmp;
    });

    return sorted;
  }, [admins, search, sort, dir]);

  const rowIds = useMemo(() => filtered.map((admin) => admin.userId), [filtered]);

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

  const selectableRows = pageRows.filter((admin) => admin.userId !== currentUserId);
  const allSelected =
    selectableRows.length > 0 &&
    selectableRows.every((admin) => selectedIds.includes(admin.userId));
  const someSelected = selectedIds.length > 0 && !allSelected;

  function toggleSort(column: SortColumn) {
    if (sort === column) {
      setDir((current) => (current === "asc" ? "desc" : "asc"));
    } else {
      setSort(column);
      setDir("asc");
    }
    setPage(1);
  }

  function toggleAll() {
    setSelectedIds(
      allSelected ? [] : selectableRows.map((admin) => admin.userId),
    );
  }

  function toggleRow(id: string) {
    if (id === currentUserId) return;
    setSelectedIds((current) =>
      current.includes(id) ? current.filter((value) => value !== id) : [...current, id],
    );
  }

  function handleRemove(userIds: string[]) {
    setError(null);
    startTransition(async () => {
      const result = await removePlatformAdminsAction(userIds);
      if (!result.ok) {
        setError(result.error ?? "Could not remove admin access.");
        return;
      }
      setConfirmOpen(false);
      setSelectedIds([]);
      router.refresh();
    });
  }

  function exportCsv() {
    const header = ["Name", "Email", "Added"];
    const lines = [
      header.join(","),
      ...filtered.map((admin) =>
        [
          csvEscape(admin.displayName),
          csvEscape(admin.email),
          csvEscape(new Date(admin.createdAt).toLocaleDateString()),
        ].join(","),
      ),
    ];
    const blob = new Blob([`${lines.join("\n")}\n`], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `platform-admins-${new Date().toISOString().slice(0, 10)}.csv`;
    anchor.click();
    URL.revokeObjectURL(url);
  }

  function SortHeader({ label, column }: { label: string; column: SortColumn }) {
    const active = sort === column;
    return (
      <div className={styles.tableSortHeader}>
        <span>{label}</span>
        <button
          type="button"
          className={`${styles.tableSortBtn} ${active ? styles.tableSortBtnActive : ""}`}
          aria-label={`Sort by ${label}`}
          onClick={() => toggleSort(column)}
        >
          <IconSort direction={active ? dir : null} />
        </button>
      </div>
    );
  }

  return (
    <>
      <div className={styles.pageHeaderActions}>
        <ClientAdminLayoutToggle layout={layout} onChange={setLayout} />
        <input
          type="search"
          className={styles.input}
          placeholder="Search admins"
          value={search}
          onChange={(e) => {
            setSearch(e.target.value);
            setPage(1);
          }}
          aria-label="Search platform admins"
        />
        <button
          type="button"
          className={`${styles.btnSecondary} ${styles.btnPill}`}
          onClick={exportCsv}
        >
          Export
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
            Remove access
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
          <section className={styles.kanbanColumn}>
            <header className={styles.kanbanColumnHeader}>
              <h2 className={styles.kanbanColumnTitle}>Platform admins</h2>
              <span className={styles.kanbanColumnCount}>{filtered.length}</span>
            </header>
            <div className={`${styles.kanbanColumnBody} kanban-column-scroll`}>
              {filtered.length === 0 ? (
                <p className={styles.kanbanEmpty}>No platform admins found.</p>
              ) : (
                filtered.map((admin) => (
                  <div key={admin.userId} className={styles.kanbanCard}>
                    <div className={styles.tableCellPerson}>
                      <UserAvatar email={admin.email} displayName={admin.displayName} />
                      <strong className={styles.kanbanCardTitle}>
                        {admin.displayName}
                        {admin.userId === currentUserId && (
                          <span className={styles.youBadge}>You</span>
                        )}
                      </strong>
                    </div>
                    <div className={styles.kanbanCardContact}>
                      <span className={styles.kanbanCardContactText}>{admin.email}</span>
                    </div>
                    <div className={styles.kanbanCardFooter}>
                      <time className={styles.kanbanCardDate} dateTime={admin.createdAt}>
                        Added {new Date(admin.createdAt).toLocaleDateString()}
                      </time>
                    </div>
                  </div>
                ))
              )}
            </div>
          </section>
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
                  aria-label="Select all admins on this page"
                  disabled={selectableRows.length === 0}
                />
              </th>
              <th>
                <SortHeader label="Name" column="name" />
              </th>
              <th>
                <SortHeader label="Email" column="email" />
              </th>
              <th>
                <SortHeader label="Added" column="added" />
              </th>
              <th className={styles.tableActionCol} aria-label="Actions" />
            </tr>
          </thead>
          <tbody>
            {pageRows.length === 0 ? (
              <tr>
                <td colSpan={5} className={styles.tableEmptyCell}>
                  {search ? "No admins match your search." : "No platform admins found."}
                </td>
              </tr>
            ) : (
              pageRows.map((admin) => {
                const isSelf = admin.userId === currentUserId;
                const selected = selectedIds.includes(admin.userId);
                return (
                  <tr key={admin.userId} data-selected={selected ? "true" : undefined}>
                    <td className={styles.tableSelectCol}>
                      <input
                        type="checkbox"
                        checked={selected}
                        onChange={() => toggleRow(admin.userId)}
                        aria-label={`Select ${admin.displayName}`}
                        disabled={isSelf}
                      />
                    </td>
                    <td>
                      <div className={styles.tableCellPerson}>
                        <UserAvatar email={admin.email} displayName={admin.displayName} />
                        <span className={styles.tableCellName}>
                          {admin.displayName}
                          {isSelf && <span className={styles.youBadge}>You</span>}
                        </span>
                      </div>
                    </td>
                    <td>{admin.email}</td>
                    <td>{new Date(admin.createdAt).toLocaleDateString()}</td>
                    <td className={`${styles.tableActionCol} ${styles.tableActionsCell}`}>
                      {!isSelf && (
                        <RowActionsMenu
                          ariaLabel={`Actions for ${admin.displayName}`}
                          disabled={pending}
                          estimatedHeight={48}
                        >
                          <button
                            type="button"
                            className={`${styles.dropdownItem} ${styles.dropdownItemDanger}`}
                            role="menuitem"
                            onClick={() => handleRemove([admin.userId])}
                          >
                            Remove access
                          </button>
                        </RowActionsMenu>
                      )}
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
              <label className={styles.tableFooterPerPage} htmlFor="platform-admins-per-page">
                <span>Rows</span>
                <DropdownSelect
                  id="platform-admins-per-page"
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

      {confirmOpen && (
        <div className={styles.modalOverlay} onClick={() => !pending && setConfirmOpen(false)}>
          <div
            className={styles.modalPanel}
            role="dialog"
            aria-modal="true"
            aria-labelledby="remove-platform-admins-title"
            onClick={(e) => e.stopPropagation()}
          >
            <div className={styles.modalHeader}>
              <div>
                <h2 id="remove-platform-admins-title" className={styles.modalTitle}>
                  Remove {selectedIds.length}{" "}
                  {selectedIds.length === 1 ? "admin" : "admins"}?
                </h2>
                <p className={styles.modalSubtitle}>
                  Selected users will lose access to the admin portal. This cannot be undone.
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
                  onClick={() => handleRemove(selectedIds)}
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
