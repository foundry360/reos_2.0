"use client";

import { useState, type MouseEvent, type ReactNode } from "react";
import type { PersonTaskSummary } from "@/lib/crm/person-activities";
import { ActivityTypeIcon } from "@/components/shell/activity-date-feed";
import { RelativeTime } from "@/components/shell/relative-time";
import { displayValue } from "@/lib/display-value";
import { TaskExpandPanel } from "./task-expand-panel";
import styles from "@/components/shell/shell.module.css";

function formatDueDate(value: string | null): string {
  if (!value) return displayValue(null);
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  }).format(new Date(value));
}

function formatActivityTime(iso: string): string {
  const date = new Date(iso);
  const datePart = new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  }).format(date);
  const timePart = new Intl.DateTimeFormat("en-US", {
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
  }).format(date);
  return `${datePart} at ${timePart}`;
}

function IconCalendarMini() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <rect x="3" y="5" width="18" height="16" rx="2" stroke="currentColor" strokeWidth="2" />
      <path d="M8 3v4M16 3v4M3 10h18" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    </svg>
  );
}

function TaskSection({
  title,
  children,
}: {
  title: string;
  children: ReactNode;
}) {
  return (
    <section className={styles.personTasksSection}>
      <h3 className={styles.personTasksSectionTitle}>{title}</h3>
      {children}
    </section>
  );
}

export function ExpandableTasksList({
  tasks,
  variant = "person",
}: {
  tasks: PersonTaskSummary[];
  variant?: "person" | "deal";
}) {
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const upcoming = tasks.filter((task) => task.status !== "done");
  const completed = tasks.filter((task) => task.status === "done");

  function toggle(taskId: string) {
    setExpandedId((current) => (current === taskId ? null : taskId));
  }

  function onRowClick(event: MouseEvent<HTMLElement>, taskId: string) {
    const target = event.target as HTMLElement | null;
    if (target?.closest("a, button, input, textarea, label")) return;
    toggle(taskId);
  }

  function renderItems(items: PersonTaskSummary[]) {
    if (variant === "deal") {
      return (
        <ul className={styles.dealActivityList}>
          {items.map((task) => {
            const expanded = expandedId === task.id;
            const showDue = task.status !== "done" && Boolean(task.dueAt);
            const stampIso = showDue ? task.dueAt! : task.updatedAt;
            return (
              <li key={task.id} className={styles.dealActivityTreeItem}>
                <div
                  className={`${styles.dealActivityItem} ${styles.taskFeedRow} ${
                    expanded ? styles.taskFeedRowExpanded : ""
                  }`}
                  role="button"
                  tabIndex={0}
                  aria-expanded={expanded}
                  onClick={(event) => onRowClick(event, task.id)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" || event.key === " ") {
                      event.preventDefault();
                      toggle(task.id);
                    }
                  }}
                >
                  <ActivityTypeIcon type="task" />
                  <span className={styles.dealActivityMain}>
                    <span className={styles.dealActivityTitle}>{task.title}</span>
                    <span className={styles.dealActivityMeta}>
                      {task.status === "done" ? "Done" : "Open"}
                    </span>
                  </span>
                  <time
                    className={`${styles.dealActivityTime}${
                      showDue ? ` ${styles.dealActivityTimeDue}` : ""
                    }`}
                    dateTime={stampIso}
                  >
                    {showDue ? (
                      <>
                        <IconCalendarMini />
                        <span>Due: {formatActivityTime(stampIso)}</span>
                      </>
                    ) : (
                      formatActivityTime(stampIso)
                    )}
                  </time>
                </div>
                {expanded ? (
                  <div className={styles.taskFeedExpand}>
                    <TaskExpandPanel
                      task={task}
                      onClose={() => setExpandedId(null)}
                    />
                  </div>
                ) : null}
              </li>
            );
          })}
        </ul>
      );
    }

    return (
      <ul className={styles.personLinkedList}>
        {items.map((task) => {
          const expanded = expandedId === task.id;
          return (
            <li key={task.id}>
              <div
                className={`${styles.personLinkedItem} ${styles.taskFeedRow} ${
                  expanded ? styles.taskFeedRowExpanded : ""
                }`}
                role="button"
                tabIndex={0}
                aria-expanded={expanded}
                onClick={(event) => onRowClick(event, task.id)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" || event.key === " ") {
                    event.preventDefault();
                    toggle(task.id);
                  }
                }}
              >
                <ActivityTypeIcon type="task" />
                <span className={styles.personLinkedItemMain}>
                  <span className={styles.personLinkedItemTitle}>{task.title}</span>
                  <span className={styles.personLinkedItemMeta}>
                    {task.status === "done" ? "Done" : "Open"}
                    {task.dueAt ? ` · Due ${formatDueDate(task.dueAt)}` : ""}
                  </span>
                </span>
                <time
                  className={styles.personLinkedItemTime}
                  dateTime={task.updatedAt}
                >
                  <RelativeTime iso={task.updatedAt} />
                </time>
              </div>
              {expanded ? (
                <div className={styles.taskFeedExpand}>
                  <TaskExpandPanel
                    task={task}
                    onClose={() => setExpandedId(null)}
                  />
                </div>
              ) : null}
            </li>
          );
        })}
      </ul>
    );
  }

  return (
    <div
      className={
        variant === "deal"
          ? `${styles.dealActivityFeed} ${styles.personTasksStack}`
          : styles.personTasksStack
      }
    >
      {upcoming.length > 0 ? (
        <TaskSection title="Upcoming">{renderItems(upcoming)}</TaskSection>
      ) : null}
      {completed.length > 0 ? (
        <TaskSection title="Completed">{renderItems(completed)}</TaskSection>
      ) : null}
    </div>
  );
}
