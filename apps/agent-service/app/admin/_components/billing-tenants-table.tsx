"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import { AccountStatusBadge } from "@/lib/admin/account-status";
import type { BillingTenantRow } from "@/lib/admin/billing-types";
import { formatUsdFromCents } from "@/lib/admin/billing-format";
import { DropdownSelect } from "@/components/shell/dropdown-select";
import { PAGE_SIZES } from "@/lib/admin/accounts-list-params";
import type { AdminLayout } from "./admin-layout-toggle";
import styles from "@/components/shell/shell.module.css";

function csvEscape(value: string): string {
  if (/[",\n]/.test(value)) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

interface BillingTenantsTableProps {
  tenants: BillingTenantRow[];
  filterMissing?: boolean;
  layout?: AdminLayout;
}

function BillingKanbanCard({ tenant }: { tenant: BillingTenantRow }) {
  return (
    <div className={styles.kanbanCard}>
      <div className={styles.kanbanCardTop}>
        <AccountStatusBadge status={tenant.status} />
      </div>
      <Link href={tenant.href} className={styles.kanbanCardTitleLink}>
        <strong className={styles.kanbanCardTitle}>{tenant.name}</strong>
      </Link>
      <div className={styles.kanbanCardContact}>
        <span className={styles.kanbanCardContactRow}>
          <span className={styles.kanbanCardContactText}>{tenant.slug}</span>
        </span>
        <span className={styles.kanbanCardContactRow}>
          <span className={styles.kanbanCardContactText}>
            {formatUsdFromCents(tenant.cycleUsageCents)} this cycle
          </span>
        </span>
      </div>
      <div className={styles.kanbanCardFooter}>
        <Link href={tenant.href} className={styles.tableFooterLink}>
          View
        </Link>
      </div>
    </div>
  );
}

export function BillingTenantsTable({
  tenants,
  filterMissing = false,
  layout = "list",
}: BillingTenantsTableProps) {
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(1);
  const [perPage, setPerPage] = useState<(typeof PAGE_SIZES)[number]>(25);

  const filtered = useMemo(() => {
    const term = search.trim().toLowerCase();
    let rows = tenants;
    if (filterMissing) {
      rows = rows.filter(
        (tenant) =>
          !tenant.stripeCustomerId &&
          (tenant.status === "active" || tenant.status === "testing"),
      );
    }
    if (!term) return rows;
    return rows.filter(
      (tenant) =>
        tenant.name.toLowerCase().includes(term) || tenant.slug.toLowerCase().includes(term),
    );
  }, [tenants, search, filterMissing]);

  const totalPages = Math.max(1, Math.ceil(filtered.length / perPage));
  const safePage = Math.min(page, totalPages);
  const from = filtered.length === 0 ? 0 : (safePage - 1) * perPage + 1;
  const to = Math.min(safePage * perPage, filtered.length);
  const pageRows = filtered.slice((safePage - 1) * perPage, safePage * perPage);

  const kanbanColumns = useMemo(() => {
    const connected = filtered.filter((tenant) => Boolean(tenant.stripeCustomerId));
    const missing = filtered.filter((tenant) => !tenant.stripeCustomerId);
    return { connected, missing };
  }, [filtered]);

  function exportCsv() {
    const header = ["Account", "Slug", "Status", "Billing", "Cycle Usage"];
    const lines = [
      header.join(","),
      ...filtered.map((tenant) =>
        [
          csvEscape(tenant.name),
          csvEscape(tenant.slug),
          csvEscape(tenant.status),
          tenant.stripeCustomerId ? "Connected" : "Not configured",
          formatUsdFromCents(tenant.cycleUsageCents),
        ].join(","),
      ),
    ];
    const blob = new Blob([`${lines.join("\n")}\n`], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `billing-tenants-${new Date().toISOString().slice(0, 10)}.csv`;
    anchor.click();
    URL.revokeObjectURL(url);
  }

  return (
    <section className={styles.tableWrap}>
      <div className={styles.billingTableHeader}>
        <div>
          <h2 className={styles.dashCardTitle}>Tenant usage</h2>
          <p className={styles.dashCardSubtitle}>Current cycle by account</p>
        </div>
        <div className={styles.pageHeaderActions}>
          <input
            type="search"
            className={styles.input}
            placeholder="Search accounts"
            value={search}
            onChange={(e) => {
              setSearch(e.target.value);
              setPage(1);
            }}
            aria-label="Search billing tenants"
          />
          <button type="button" className={`${styles.btnSecondary} ${styles.btnPill}`} onClick={exportCsv}>
            Export
          </button>
        </div>
      </div>

      {filtered.length === 0 ? (
        <p className={styles.empty}>
          {filterMissing
            ? "All active and testing accounts have billing configured."
            : search
              ? "No accounts match your search."
              : "No accounts yet."}
        </p>
      ) : layout === "kanban" ? (
        <div className={`${styles.kanbanBoard} kanban-board-scroll`}>
          <section className={styles.kanbanColumn}>
            <header className={styles.kanbanColumnHeader}>
              <h2 className={styles.kanbanColumnTitle}>Connected</h2>
              <span className={styles.kanbanColumnCount}>{kanbanColumns.connected.length}</span>
            </header>
            <div className={`${styles.kanbanColumnBody} kanban-column-scroll`}>
              {kanbanColumns.connected.length === 0 ? (
                <p className={styles.kanbanEmpty}>No accounts</p>
              ) : (
                kanbanColumns.connected.map((tenant) => (
                  <BillingKanbanCard key={tenant.id} tenant={tenant} />
                ))
              )}
            </div>
          </section>
          <section className={styles.kanbanColumn}>
            <header className={styles.kanbanColumnHeader}>
              <h2 className={styles.kanbanColumnTitle}>Not configured</h2>
              <span className={styles.kanbanColumnCount}>{kanbanColumns.missing.length}</span>
            </header>
            <div className={`${styles.kanbanColumnBody} kanban-column-scroll`}>
              {kanbanColumns.missing.length === 0 ? (
                <p className={styles.kanbanEmpty}>No accounts</p>
              ) : (
                kanbanColumns.missing.map((tenant) => (
                  <BillingKanbanCard key={tenant.id} tenant={tenant} />
                ))
              )}
            </div>
          </section>
        </div>
      ) : (
        <>
          <table className={styles.table}>
            <thead>
              <tr>
                <th>Account</th>
                <th>Status</th>
                <th>Billing</th>
                <th>Cycle usage</th>
                <th className={styles.tableActionCol} aria-label="Actions" />
              </tr>
            </thead>
            <tbody>
              {pageRows.map((tenant) => (
                <tr key={tenant.id}>
                  <td>
                    <Link href={tenant.href} className={styles.tableCellLink}>
                      {tenant.name}
                    </Link>
                    <div className={styles.billingTableSubtext}>{tenant.slug}</div>
                  </td>
                  <td>
                    <AccountStatusBadge status={tenant.status} />
                  </td>
                  <td>{tenant.stripeCustomerId ? "Connected" : "Not configured"}</td>
                  <td className={styles.billingAmountCell}>
                    {formatUsdFromCents(tenant.cycleUsageCents)}
                  </td>
                  <td className={`${styles.tableActionCol} ${styles.tableActionsCell}`}>
                    <Link href={tenant.href} className={styles.tableFooterLink}>
                      View
                    </Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>

          <div className={styles.tableFooter}>
            <div className={styles.tableFooterMeta}>
              <span>
                <strong>
                  {from} to {to}
                </strong>{" "}
                items of {filtered.length}
              </span>
              <label className={styles.tableFooterPerPage} htmlFor="billing-tenants-per-page">
                <span>Rows</span>
                <DropdownSelect
                  id="billing-tenants-per-page"
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
        </>
      )}
    </section>
  );
}
