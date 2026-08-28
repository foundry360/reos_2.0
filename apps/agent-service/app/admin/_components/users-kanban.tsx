"use client";

import Link from "next/link";
import { UserRowActions } from "./user-row-actions";
import type { UserRow } from "@/lib/admin/users-list";
import { formatPhoneDisplay } from "@/lib/phone-display";
import { UserAvatar } from "@/components/shell/user-avatar";
import styles from "@/components/shell/shell.module.css";

interface UsersKanbanProps {
  columns: Record<"owner" | "agent" | "viewer", UserRow[]>;
}

const COLUMN_LABELS = {
  owner: "Owner",
  agent: "Agent",
  viewer: "Viewer",
} as const;

function formatShortDate(iso: string): string {
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
  }).format(new Date(iso));
}

function KanbanCard({ user }: { user: UserRow }) {
  const phone = formatPhoneDisplay(user.phone);

  return (
    <div className={styles.kanbanCard}>
      <div className={styles.kanbanCardTop}>
        <span className={`${styles.badge} ${styles.badgeRole}`}>{user.userTypeLabel}</span>
        <UserRowActions
          tenantId={user.tenantId}
          membershipId={user.membershipId}
          userName={user.name}
        />
      </div>
      <div className={styles.tableCellPerson}>
        <UserAvatar email={user.email} displayName={user.name} avatarUrl={user.avatarUrl} />
        <strong className={styles.kanbanCardTitle}>{user.name}</strong>
      </div>
      <div className={styles.kanbanCardContact}>
        <span className={styles.kanbanCardContactRow}>
          <span className={styles.kanbanCardContactText}>{user.email}</span>
        </span>
        {phone && (
          <span className={styles.kanbanCardContactRow}>
            <span className={styles.kanbanCardContactText}>{phone}</span>
          </span>
        )}
        <Link href={`/admin/accounts/${user.tenantId}`} className={styles.kanbanCardContactRow}>
          <span className={styles.kanbanCardContactText}>{user.tenantName}</span>
        </Link>
      </div>
      <div className={styles.kanbanCardFooter}>
        <time className={styles.kanbanCardDate} dateTime={user.createdAt}>
          {formatShortDate(user.createdAt)}
        </time>
      </div>
    </div>
  );
}

export function UsersKanban({ columns }: UsersKanbanProps) {
  return (
    <div className={`${styles.kanbanBoard} kanban-board-scroll`}>
      {(Object.keys(COLUMN_LABELS) as Array<keyof typeof COLUMN_LABELS>).map((role) => (
        <section key={role} className={styles.kanbanColumn}>
          <header className={styles.kanbanColumnHeader}>
            <h2 className={styles.kanbanColumnTitle}>{COLUMN_LABELS[role]}</h2>
            <span className={styles.kanbanColumnCount}>{columns[role].length}</span>
          </header>
          <div className={`${styles.kanbanColumnBody} kanban-column-scroll`}>
            {columns[role].length === 0 ? (
              <p className={styles.kanbanEmpty}>No users</p>
            ) : (
              columns[role].map((user) => <KanbanCard key={user.membershipId} user={user} />)
            )}
          </div>
        </section>
      ))}
    </div>
  );
}
