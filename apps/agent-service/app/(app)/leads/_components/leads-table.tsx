"use client";

import Link from "next/link";
import { useEffect, useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { LeadRowActions } from "./lead-row-actions";
import { LeadsPagination } from "./leads-pagination";
import { PersonActivityTrigger } from "./person-activity-trigger";
import { deleteLeadsAction } from "@/lib/crm/crm-actions";
import {
  personBasePath,
  personPlural,
  personSingular,
  type PersonKind,
} from "@/lib/crm/person-kind";
import {
  buildSortHref,
  type LeadSortColumn,
  type LeadsListParams,
} from "@/lib/leads/leads-list-params";
import type { LeadRow } from "@/lib/leads/leads-types";
import type { LeadStatus } from "@/lib/coordinator";
import { formatPhoneDisplay } from "@/lib/phone-display";
import { TableEmailCell, TablePhoneCell } from "@/components/shell/table-contact-cells";
import { accountInitials } from "@/lib/user-display";
import { formatRelativeTime } from "@/lib/admin/activity-timeline";
import styles from "@/components/shell/shell.module.css";

const STATUS_BADGE_CLASS: Record<LeadStatus, string> = {
  New: styles.badgeLeadNew,
  Working: styles.badgeLeadWorking,
  Contacted: styles.badgeLeadContacted,
  Qualified: styles.badgeLeadQualified,
  Converted: styles.badgeLeadConverted,
};

function LeadStatusBadge({ status, label }: { status: LeadStatus; label: string }) {
  return <span className={`${styles.badge} ${STATUS_BADGE_CLASS[status]}`}>{label}</span>;
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
  basePath,
}: {
  label: string;
  column: LeadSortColumn;
  params: LeadsListParams;
  basePath: string;
}) {
  const active = params.sort === column;
  const nextDir = active && params.dir === "asc" ? "descending" : "ascending";

  return (
    <div className={styles.tableSortHeader}>
      <span>{label}</span>
      <Link
        href={buildSortHref(params, column, basePath)}
        className={`${styles.tableSortBtn} ${active ? styles.tableSortBtnActive : ""}`}
        aria-label={`Sort by ${label} ${nextDir}`}
      >
        <IconSort direction={active ? params.dir : null} />
      </Link>
    </div>
  );
}

interface LeadsTableProps {
  rows: LeadRow[];
  params: LeadsListParams;
  total: number;
  kind?: PersonKind;
}

export function LeadsTable({ rows, params, total, kind = "lead" }: LeadsTableProps) {
  const router = useRouter();
  const basePath = personBasePath(kind);
  const plural = personPlural(kind);
  const singular = personSingular(kind);
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
      const result = await deleteLeadsAction(selectedIds);
      if (!result.ok) {
        setError(result.error ?? `Could not delete ${plural}.`);
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
          <span className={styles.bulkActionCount}>
            {selectedIds.length} selected
          </span>
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
                  aria-label={`Select all ${plural} on this page`}
                />
              </th>
              <th>
                <SortHeader label="Name" column="name" params={params} basePath={basePath} />
              </th>
              <th>Phone</th>
              <th>Email</th>
              <th>
                <SortHeader label="Status" column="status" params={params} basePath={basePath} />
              </th>
              <th>
                <SortHeader
                  label="Updated"
                  column="updated_at"
                  params={params}
                  basePath={basePath}
                />
              </th>
              <th className={styles.tableActionCol} aria-label="Actions" />
            </tr>
          </thead>
          <tbody>
            {rows.map((lead) => {
              const selected = selectedIds.includes(lead.id);
              return (
                <tr key={lead.id} data-selected={selected ? "true" : undefined}>
                  <td className={styles.tableSelectCol}>
                    <input
                      type="checkbox"
                      checked={selected}
                      onChange={() => toggleRow(lead.id)}
                      aria-label={`Select ${lead.name}`}
                    />
                  </td>
                  <td>
                    <div className={styles.tableCellPerson}>
                      <span className={styles.avatar}>{accountInitials(lead.name)}</span>
                      <div className={styles.tableCellPersonMain}>
                        <Link href={`${basePath}/${lead.id}`} className={styles.tableCellLink}>
                          <span className={styles.tableCellName}>{lead.name}</span>
                        </Link>
                        <span className={styles.tableCellPersonDivider} aria-hidden="true" />
                        <PersonActivityTrigger personName={lead.name} kind={kind} />
                      </div>
                    </div>
                  </td>
                  <td>
                    <TablePhoneCell value={formatPhoneDisplay(lead.phone)} />
                  </td>
                  <td>
                    <TableEmailCell value={lead.email} />
                  </td>
                  <td>
                    <LeadStatusBadge status={lead.leadStatus} label={lead.leadStatusLabel} />
                  </td>
                  <td>
                    <time dateTime={lead.updatedAt}>{formatRelativeTime(lead.updatedAt)}</time>
                  </td>
                  <td className={`${styles.tableActionCol} ${styles.tableActionsCell}`}>
                    <LeadRowActions lead={lead} kind={kind} />
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
        <LeadsPagination params={params} total={total} kind={kind} />
      </div>

      {confirmOpen && (
        <div
          className={styles.modalOverlay}
          onClick={() => !pending && setConfirmOpen(false)}
        >
          <div
            className={styles.modalPanel}
            role="dialog"
            aria-modal="true"
            aria-labelledby="delete-leads-title"
            onClick={(e) => e.stopPropagation()}
          >
            <div className={styles.modalHeader}>
              <div>
                <h2 id="delete-leads-title" className={styles.modalTitle}>
                  Delete {selectedIds.length} {selectedIds.length === 1 ? singular : plural}?
                </h2>
                <p className={styles.modalSubtitle}>
                  This permanently removes the selected {selectedIds.length === 1 ? singular : plural}{" "}
                  and related messages. This cannot be undone.
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
