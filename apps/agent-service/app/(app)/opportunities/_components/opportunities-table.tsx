"use client";

import Link from "next/link";
import { useEffect, useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { OpportunityRowActions } from "./opportunity-row-actions";
import { OpportunitiesPagination } from "./opportunities-pagination";
import { deleteOpportunitiesAction } from "@/lib/crm/crm-actions";
import {
  buildOpportunitySortHref,
  type OpportunitiesListParams,
  type OpportunitySortColumn,
} from "@/lib/opportunities/opportunities-list-params";
import type { OpportunityRow } from "@/lib/opportunities/opportunities-types";
import type { OpportunityStage } from "@/lib/opportunities/opportunity-stages";
import {
  OPPORTUNITY_PRIORITY_COLORS,
  type OpportunityPriority,
} from "@/lib/opportunities/opportunity-fields";
import { displayValue } from "@/lib/display-value";
import { accountInitials } from "@/lib/user-display";
import { RelativeTime } from "@/components/shell/relative-time";
import styles from "@/components/shell/shell.module.css";

const STAGE_BADGE_CLASS: Record<OpportunityStage, string> = {
  New: styles.badgeLeadNew,
  AI_Qualifying: styles.badgeLeadWorking,
  Qualified: styles.badgeLeadQualified,
  Appointment_Set: styles.badgeLeadContacted,
  Nurture: styles.badgeLeadWorking,
  Closed_Won: styles.badgeLeadConverted,
};

function PriorityCell({ priority }: { priority: OpportunityPriority | null }) {
  if (!priority) return <>{displayValue(null)}</>;
  return (
    <span className={styles.priorityInline}>
      <span
        className={styles.optionColorDot}
        style={{ backgroundColor: OPPORTUNITY_PRIORITY_COLORS[priority] }}
        aria-hidden
      />
      {priority}
    </span>
  );
}

interface SelectOption {
  id: string;
  label: string;
}

function formatUsd(cents: number | null): string {
  if (cents == null) return displayValue(null);
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 0,
  }).format(cents / 100);
}

function formatDate(value: string | null): string {
  if (!value) return displayValue(null);
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  }).format(new Date(`${value}T12:00:00`));
}

function contactHref(row: OpportunityRow): string | null {
  if (!row.contactId) return null;
  if (row.contactRecordType === "contact") return `/contacts/${row.contactId}`;
  return `/leads/${row.contactId}`;
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
  column: OpportunitySortColumn;
  params: OpportunitiesListParams;
}) {
  const active = params.sort === column;
  const nextDir = active && params.dir === "asc" ? "descending" : "ascending";

  return (
    <div className={styles.tableSortHeader}>
      <span>{label}</span>
      <Link
        href={buildOpportunitySortHref(params, column)}
        className={`${styles.tableSortBtn} ${active ? styles.tableSortBtnActive : ""}`}
        aria-label={`Sort by ${label} ${nextDir}`}
      >
        <IconSort direction={active ? params.dir : null} />
      </Link>
    </div>
  );
}

interface OpportunitiesTableProps {
  rows: OpportunityRow[];
  params: OpportunitiesListParams;
  total: number;
  contactOptions: SelectOption[];
  agentOptions: SelectOption[];
}

export function OpportunitiesTable({
  rows,
  params,
  total,
  contactOptions,
  agentOptions,
}: OpportunitiesTableProps) {
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
      const result = await deleteOpportunitiesAction(selectedIds);
      if (!result.ok) {
        setError(result.error ?? "Could not delete opportunities.");
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
                  aria-label="Select all opportunities on this page"
                />
              </th>
              <th>
                <SortHeader label="Name" column="name" params={params} />
              </th>
              <th>Client</th>
              <th>
                <SortHeader label="Stage" column="stage" params={params} />
              </th>
              <th>Priority</th>
              <th>
                <SortHeader label="Amount" column="amount" params={params} />
              </th>
              <th>
                <SortHeader label="Expected close" column="expected_close_date" params={params} />
              </th>
              <th>
                <SortHeader label="Updated" column="updated_at" params={params} />
              </th>
              <th className={styles.tableActionCol} aria-label="Actions" />
            </tr>
          </thead>
          <tbody>
            {rows.map((opportunity) => {
              const selected = selectedIds.includes(opportunity.id);
              const href = contactHref(opportunity);
              return (
                <tr key={opportunity.id} data-selected={selected ? "true" : undefined}>
                  <td className={styles.tableSelectCol}>
                    <input
                      type="checkbox"
                      checked={selected}
                      onChange={() => toggleRow(opportunity.id)}
                      aria-label={`Select ${opportunity.name}`}
                    />
                  </td>
                  <td>
                    <div className={styles.tableCellPerson}>
                      <span className={`${styles.avatar} ${styles.opportunityInitialsAvatar}`}>
                        {accountInitials(opportunity.name)}
                      </span>
                      <div className={styles.tableCellPersonMain}>
                        <Link
                          href={`/opportunities/${opportunity.id}`}
                          className={`${styles.tableCellName} ${styles.tableCellLink}`}
                        >
                          {opportunity.name}
                        </Link>
                      </div>
                    </div>
                  </td>
                  <td>
                    {href && opportunity.contactName ? (
                      <Link href={href} className={styles.contactLink}>
                        {opportunity.contactName}
                      </Link>
                    ) : (
                      displayValue(opportunity.contactName)
                    )}
                  </td>
                  <td>
                    <span
                      className={`${styles.badge} ${STAGE_BADGE_CLASS[opportunity.stage]}`}
                    >
                      {opportunity.stageLabel}
                    </span>
                  </td>
                  <td>
                    <PriorityCell priority={opportunity.priority} />
                  </td>
                  <td>{formatUsd(opportunity.amountCents)}</td>
                  <td>{formatDate(opportunity.expectedCloseDate)}</td>
                  <td>
                    <time dateTime={opportunity.updatedAt}>
                      <RelativeTime iso={opportunity.updatedAt} />
                    </time>
                  </td>
                  <td className={`${styles.tableActionCol} ${styles.tableActionsCell}`}>
                    <OpportunityRowActions
                      opportunity={opportunity}
                      contactOptions={contactOptions}
                      agentOptions={agentOptions}
                    />
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
        <OpportunitiesPagination params={params} total={total} />
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
            aria-labelledby="delete-opportunities-title"
            onClick={(e) => e.stopPropagation()}
          >
            <div className={styles.modalHeader}>
              <div>
                <h2 id="delete-opportunities-title" className={styles.modalTitle}>
                  Delete {selectedIds.length}{" "}
                  {selectedIds.length === 1 ? "opportunity" : "opportunities"}?
                </h2>
                <p className={styles.modalSubtitle}>
                  This permanently removes the selected{" "}
                  {selectedIds.length === 1 ? "opportunity" : "opportunities"}. This cannot be
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
