"use client";

import Link from "next/link";
import { AccountRowActions } from "./account-row-actions";
import { AccountStatusBadge } from "@/lib/admin/account-status";
import type { AccountRow } from "@/lib/admin/accounts-list";
import { formatPhoneDisplay } from "@/lib/phone-display";
import { accountInitials } from "@/lib/user-display";
import styles from "@/components/shell/shell.module.css";

interface ActiveAccountsKanbanProps {
  columns: { active: AccountRow[]; paused: AccountRow[] };
  showPaused: boolean;
}

function formatShortDate(iso: string): string {
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
  }).format(new Date(iso));
}

function IconPhone() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path
        d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72c.127.96.361 1.903.7 2.81a2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45c.907.339 1.85.573 2.81.7A2 2 0 0 1 22 16.92z"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function IconMail() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <rect x="2" y="4" width="20" height="16" rx="2" stroke="currentColor" strokeWidth="2" />
      <path
        d="M22 6l-10 7L2 6"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function KanbanCard({ account }: { account: AccountRow }) {
  const phone = formatPhoneDisplay(account.phone);
  const email = account.email?.trim() || null;

  return (
    <div className={styles.kanbanCard}>
      <div className={styles.kanbanCardTop}>
        <AccountStatusBadge status={account.status} />
        <AccountRowActions accountId={account.id} accountName={account.name} stopDrag />
      </div>
      <Link href={`/admin/accounts/${account.id}`} className={styles.kanbanCardTitleLink}>
        <strong className={styles.kanbanCardTitle}>{account.name}</strong>
      </Link>
      <div className={styles.kanbanCardContact}>
        {phone && (
          <span className={styles.kanbanCardContactRow}>
            <span className={styles.kanbanCardContactIcon}>
              <IconPhone />
            </span>
            <span className={styles.kanbanCardContactText}>{phone}</span>
          </span>
        )}
        {email && (
          <span className={styles.kanbanCardContactRow}>
            <span className={styles.kanbanCardContactIcon}>
              <IconMail />
            </span>
            <span className={styles.kanbanCardContactText}>{email}</span>
          </span>
        )}
      </div>
      <div className={styles.kanbanCardFooter}>
        <time className={styles.kanbanCardDate} dateTime={account.created_at}>
          {formatShortDate(account.created_at)}
        </time>
        <span className={styles.kanbanCardAvatar} aria-hidden="true">
          {accountInitials(account.name)}
        </span>
      </div>
    </div>
  );
}

function KanbanColumn({
  title,
  accounts,
}: {
  title: string;
  accounts: AccountRow[];
}) {
  return (
    <section className={styles.kanbanColumn}>
      <header className={styles.kanbanColumnHeader}>
        <h2 className={styles.kanbanColumnTitle}>{title}</h2>
        <span className={styles.kanbanColumnCount}>{accounts.length}</span>
      </header>
      <div className={`${styles.kanbanColumnBody} kanban-column-scroll`}>
        {accounts.length === 0 ? (
          <p className={styles.kanbanEmpty}>No accounts</p>
        ) : (
          accounts.map((account) => <KanbanCard key={account.id} account={account} />)
        )}
      </div>
    </section>
  );
}

export function ActiveAccountsKanban({ columns, showPaused }: ActiveAccountsKanbanProps) {
  return (
    <div className={`${styles.kanbanBoard} kanban-board-scroll`}>
      <KanbanColumn title="Active" accounts={columns.active} />
      {showPaused && <KanbanColumn title="Paused" accounts={columns.paused} />}
    </div>
  );
}
