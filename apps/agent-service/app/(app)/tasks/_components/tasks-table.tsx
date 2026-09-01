"use client";

import { Fragment, useState, type MouseEvent } from "react";
import Link from "next/link";
import type { TaskRow } from "@/lib/crm/crm-lists";
import {
  buildTaskSortHref,
  type TaskSortColumn,
  type TasksListParams,
} from "@/lib/crm/tasks-list-params";
import { TaskExpandPanel } from "./task-expand-panel";
import { TasksPagination } from "./tasks-pagination";
import { displayValue } from "@/lib/display-value";
import { accountInitials } from "@/lib/user-display";
import styles from "@/components/shell/shell.module.css";

const COLUMN_COUNT = 7;

function formatDueDate(value: string | null): string {
  if (!value) return displayValue(null);
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  }).format(new Date(value));
}

function formatDateTime(value: string | null): string {
  if (!value) return displayValue(null);
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(value));
}

function contactHref(row: TaskRow): string | null {
  if (!row.contactId) return null;
  if (row.contactRecordType === "contact") return `/contacts/${row.contactId}`;
  return `/leads/${row.contactId}`;
}

function StatusBadge({ status }: { status: TaskRow["status"] }) {
  return (
    <span
      className={`${styles.badge} ${
        status === "done" ? styles.badgeTaskDone : styles.badgeTaskOpen
      }`}
    >
      {status === "done" ? "Done" : "Open"}
    </span>
  );
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
  column: TaskSortColumn;
  params: TasksListParams;
}) {
  const active = params.sort === column;
  const nextDir = active && params.dir === "asc" ? "descending" : "ascending";

  return (
    <div className={styles.tableSortHeader}>
      <span>{label}</span>
      <Link
        href={buildTaskSortHref(params, column)}
        className={`${styles.tableSortBtn} ${active ? styles.tableSortBtnActive : ""}`}
        aria-label={`Sort by ${label} ${nextDir}`}
      >
        <IconSort direction={active ? params.dir : null} />
      </Link>
    </div>
  );
}

interface TasksTableProps {
  rows: TaskRow[];
  params: TasksListParams;
  total: number;
  title?: string;
  pageKey?: "page" | "cpage";
  emptyLabel?: string;
}

export function TasksTable({
  rows,
  params,
  total,
  title,
  pageKey = "page",
  emptyLabel = "No tasks in this list.",
}: TasksTableProps) {
  const [expandedId, setExpandedId] = useState<string | null>(null);

  function toggleRow(taskId: string) {
    setExpandedId((current) => (current === taskId ? null : taskId));
  }

  function onRowClick(event: MouseEvent<HTMLTableRowElement>, taskId: string) {
    const target = event.target as HTMLElement | null;
    if (target?.closest("a, button, input, textarea, label")) return;
    toggleRow(taskId);
  }

  return (
    <section className={styles.tasksTableSection} aria-label={title}>
      {title ? (
        <div className={styles.tasksTableSectionHeader}>
          <h2 className={styles.tasksTableSectionTitle}>{title}</h2>
        </div>
      ) : null}
      <div className={styles.tableWrap}>
        {rows.length === 0 ? (
          <p className={styles.tasksTableEmpty}>{emptyLabel}</p>
        ) : (
          <table className={`${styles.table} ${styles.tasksTable}`}>
            <colgroup>
              <col className={styles.tasksColTask} />
              <col className={styles.tasksColContact} />
              <col className={styles.tasksColOpportunity} />
              <col className={styles.tasksColStatus} />
              <col className={styles.tasksColStart} />
              <col className={styles.tasksColEnd} />
              <col className={styles.tasksColDue} />
            </colgroup>
            <thead>
              <tr>
                <th>
                  <SortHeader label="Task" column="title" params={params} />
                </th>
                <th>Client</th>
                <th>Opportunity</th>
                <th>
                  <SortHeader label="Status" column="status" params={params} />
                </th>
                <th>
                  <SortHeader label="Start" column="start_at" params={params} />
                </th>
                <th>
                  <SortHeader label="End" column="end_at" params={params} />
                </th>
                <th>
                  <SortHeader label="Due" column="due_at" params={params} />
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => {
                const personHref = contactHref(row);
                const expanded = expandedId === row.id;
                return (
                  <Fragment key={row.id}>
                    <tr
                      className={`${styles.taskTableRow} ${
                        expanded ? styles.taskTableRowExpanded : ""
                      }`}
                      onClick={(event) => onRowClick(event, row.id)}
                      aria-expanded={expanded}
                    >
                      <td>
                        <span className={styles.tableCellName}>{row.title}</span>
                      </td>
                      <td>
                        {row.contactName ? (
                          <div className={styles.tableCellPerson}>
                            <span
                              className={`${styles.avatar} ${styles.personInitialsAvatar}`}
                            >
                              {accountInitials(row.contactName)}
                            </span>
                            <div className={styles.tableCellPersonMain}>
                              {personHref ? (
                                <Link href={personHref} className={styles.contactLink}>
                                  {row.contactName}
                                </Link>
                              ) : (
                                <span className={styles.tableCellName}>
                                  {row.contactName}
                                </span>
                              )}
                            </div>
                          </div>
                        ) : (
                          displayValue(null)
                        )}
                      </td>
                      <td>
                        {row.opportunityName && row.opportunityId ? (
                          <Link
                            href={`/opportunities/${row.opportunityId}`}
                            className={styles.tableCellLink}
                          >
                            {row.opportunityName}
                          </Link>
                        ) : (
                          displayValue(row.opportunityName)
                        )}
                      </td>
                      <td>
                        <StatusBadge status={row.status} />
                      </td>
                      <td>
                        {row.startAt ? (
                          <time dateTime={row.startAt}>
                            {formatDateTime(row.startAt)}
                          </time>
                        ) : (
                          displayValue(null)
                        )}
                      </td>
                      <td>
                        {row.endAt ? (
                          <time dateTime={row.endAt}>{formatDateTime(row.endAt)}</time>
                        ) : (
                          displayValue(null)
                        )}
                      </td>
                      <td>{formatDueDate(row.dueAt)}</td>
                    </tr>
                    {expanded ? (
                      <tr className={styles.taskExpandRow}>
                        <td colSpan={COLUMN_COUNT}>
                          <TaskExpandPanel
                            task={row}
                            onClose={() => setExpandedId(null)}
                          />
                        </td>
                      </tr>
                    ) : null}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        )}
        <TasksPagination params={params} total={total} pageKey={pageKey} />
      </div>
    </section>
  );
}
