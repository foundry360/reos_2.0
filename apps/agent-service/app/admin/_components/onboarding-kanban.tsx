"use client";

import {
  DndContext,
  DragOverlay,
  PointerSensor,
  closestCenter,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragStartEvent,
} from "@dnd-kit/core";
import { CSS } from "@dnd-kit/utilities";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState, useTransition } from "react";
import { AccountRowActions } from "./account-row-actions";
import { setTenantStatusFromStepAction } from "@/lib/admin/account-actions";
import {
  ONBOARDING_STATUSES,
  ONBOARDING_STATUS_OPTIONS,
  tenantStatusBadgeClass,
  type OnboardingStatus,
} from "@/lib/admin/account-status";
import type { AccountRow } from "@/lib/admin/accounts-list";
import { formatPhoneDisplay } from "@/lib/phone-display";
import { accountInitials } from "@/lib/user-display";
import styles from "@/components/shell/shell.module.css";

interface OnboardingKanbanProps {
  columns: Record<OnboardingStatus, AccountRow[]>;
}

function formatShortDate(iso: string): string {
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
  }).format(new Date(iso));
}

function findAccount(
  columns: Record<OnboardingStatus, AccountRow[]>,
  accountId: string,
): AccountRow | null {
  for (const status of ONBOARDING_STATUSES) {
    const match = columns[status].find((row) => row.id === accountId);
    if (match) return match;
  }
  return null;
}

function moveAccount(
  columns: Record<OnboardingStatus, AccountRow[]>,
  accountId: string,
  toStatus: OnboardingStatus,
): Record<OnboardingStatus, AccountRow[]> {
  let moved: AccountRow | undefined;

  const next = ONBOARDING_STATUSES.reduce(
    (acc, status) => {
      acc[status] = columns[status].filter((row) => {
        if (row.id === accountId) {
          moved = row;
          return false;
        }
        return true;
      });
      return acc;
    },
    {} as Record<OnboardingStatus, AccountRow[]>,
  );

  if (moved) {
    next[toStatus] = [...next[toStatus], { ...moved, status: toStatus }];
  }

  return next;
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

function KanbanCardContent({
  account,
  stageLabel,
  linkTitle = true,
  showActions = false,
}: {
  account: AccountRow;
  stageLabel: string;
  linkTitle?: boolean;
  showActions?: boolean;
}) {
  const phone = formatPhoneDisplay(account.phone);
  const email = account.email?.trim() || null;

  return (
    <>
      <div className={styles.kanbanCardTop}>
        <span
          className={`${styles.badge} ${styles.kanbanCardTag} ${tenantStatusBadgeClass(account.status)}`}
        >
          {stageLabel}
        </span>
        {showActions && (
          <AccountRowActions
            accountId={account.id}
            accountName={account.name}
            stopDrag
          />
        )}
      </div>
      {linkTitle ? (
        <Link
          href={`/admin/accounts/${account.id}`}
          className={styles.kanbanCardTitleLink}
          onPointerDown={(event) => event.stopPropagation()}
        >
          {account.name}
        </Link>
      ) : (
        <strong className={styles.kanbanCardTitle}>{account.name}</strong>
      )}
      {(phone || email) && (
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
      )}
      <div className={styles.kanbanCardFooter}>
        <time className={styles.kanbanCardDate} dateTime={account.created_at}>
          Added {formatShortDate(account.created_at)}
        </time>
        <span className={styles.kanbanCardAvatar} aria-hidden="true">
          {accountInitials(account.name)}
        </span>
      </div>
    </>
  );
}

function KanbanCardStatic({
  account,
  stageLabel,
}: {
  account: AccountRow;
  stageLabel: string;
}) {
  return (
    <div className={styles.kanbanCard}>
      <KanbanCardContent account={account} stageLabel={stageLabel} showActions />
    </div>
  );
}

function KanbanColumnStatic({
  stage,
  cards,
}: {
  stage: (typeof ONBOARDING_STATUS_OPTIONS)[number];
  cards: AccountRow[];
}) {
  return (
    <section className={styles.kanbanColumn}>
      <header className={styles.kanbanColumnHeader}>
        <h2 className={styles.kanbanColumnTitle}>{stage.label}</h2>
        <span className={styles.kanbanColumnCount}>{cards.length}</span>
      </header>
      <div className={`${styles.kanbanColumnBody} kanban-column-scroll`}>
        {cards.length === 0 ? (
          <p className={styles.kanbanEmpty}>No accounts</p>
        ) : (
          cards.map((account) => (
            <KanbanCardStatic key={account.id} account={account} stageLabel={stage.label} />
          ))
        )}
      </div>
    </section>
  );
}

function KanbanCard({
  account,
  stageLabel,
}: {
  account: AccountRow;
  stageLabel: string;
}) {
  const { attributes, listeners, setNodeRef, transform, isDragging } = useDraggable({
    id: account.id,
    data: { status: account.status },
  });

  const style = transform
    ? { transform: CSS.Translate.toString(transform) }
    : undefined;

  return (
    <div
      ref={setNodeRef}
      className={`${styles.kanbanCard} ${styles.kanbanCardDraggable} ${isDragging ? styles.kanbanCardDragging : ""}`}
      style={style}
      {...listeners}
      {...attributes}
    >
      <KanbanCardContent account={account} stageLabel={stageLabel} showActions />
    </div>
  );
}

function KanbanColumn({
  stage,
  cards,
}: {
  stage: (typeof ONBOARDING_STATUS_OPTIONS)[number];
  cards: AccountRow[];
}) {
  const { setNodeRef, isOver } = useDroppable({
    id: stage.value,
  });

  return (
    <section className={styles.kanbanColumn}>
      <header className={styles.kanbanColumnHeader}>
        <h2 className={styles.kanbanColumnTitle}>{stage.label}</h2>
        <span className={styles.kanbanColumnCount}>{cards.length}</span>
      </header>
      <div
        ref={setNodeRef}
        className={`${styles.kanbanColumnBody} kanban-column-scroll ${isOver ? styles.kanbanColumnBodyOver : ""}`}
      >
        {cards.length === 0 ? (
          <p className={styles.kanbanEmpty}>No accounts</p>
        ) : (
          cards.map((account) => (
            <KanbanCard key={account.id} account={account} stageLabel={stage.label} />
          ))
        )}
      </div>
    </section>
  );
}

export function OnboardingKanban({ columns: initialColumns }: OnboardingKanbanProps) {
  const router = useRouter();
  const [columns, setColumns] = useState(initialColumns);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setMounted(true);
  }, []);

  useEffect(() => {
    setColumns(initialColumns);
  }, [initialColumns]);

  const sensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: { distance: 8 },
    }),
  );

  const activeAccount = activeId ? findAccount(columns, activeId) : null;
  const activeStageLabel = activeAccount
    ? ONBOARDING_STATUS_OPTIONS.find((option) => option.value === activeAccount.status)?.label ??
      formatTenantStageLabel(activeAccount.status)
    : "";

  function handleDragStart(event: DragStartEvent) {
    setActiveId(String(event.active.id));
  }

  function handleDragEnd(event: DragEndEvent) {
    setActiveId(null);

    const accountId = String(event.active.id);
    const overId = event.over?.id;

    if (!overId || !ONBOARDING_STATUSES.includes(overId as OnboardingStatus)) {
      return;
    }

    const nextStatus = overId as OnboardingStatus;
    const account = findAccount(columns, accountId);

    if (!account || account.status === nextStatus) {
      return;
    }

    const previousColumns = columns;
    setColumns(moveAccount(columns, accountId, nextStatus));

    startTransition(async () => {
      const result = await setTenantStatusFromStepAction(accountId, nextStatus);
      if (!result.ok) {
        console.error(result.error ?? "Could not update status.");
        setColumns(previousColumns);
        return;
      }
      router.refresh();
    });
  }

  function handleDragCancel() {
    setActiveId(null);
  }

  if (!mounted) {
    return (
      <div className={`${styles.kanbanBoard} kanban-board-scroll`} aria-busy={isPending}>
        {ONBOARDING_STATUS_OPTIONS.map((stage) => (
          <KanbanColumnStatic
            key={stage.value}
            stage={stage}
            cards={columns[stage.value as OnboardingStatus]}
          />
        ))}
      </div>
    );
  }

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={closestCenter}
      onDragStart={handleDragStart}
      onDragEnd={handleDragEnd}
      onDragCancel={handleDragCancel}
    >
      <div
        className={`${styles.kanbanBoard} kanban-board-scroll`}
        data-busy={isPending ? "true" : undefined}
        aria-busy={isPending}
      >
        {ONBOARDING_STATUS_OPTIONS.map((stage) => (
          <KanbanColumn
            key={stage.value}
            stage={stage}
            cards={columns[stage.value as OnboardingStatus]}
          />
        ))}
      </div>

      <DragOverlay dropAnimation={null}>
        {activeAccount ? (
          <div className={`${styles.kanbanCard} ${styles.kanbanCardOverlay}`}>
            <KanbanCardContent
              account={activeAccount}
              stageLabel={activeStageLabel}
              linkTitle={false}
            />
          </div>
        ) : null}
      </DragOverlay>
    </DndContext>
  );
}

function formatTenantStageLabel(status: string): string {
  return (
    ONBOARDING_STATUS_OPTIONS.find((option) => option.value === status)?.label ?? status
  );
}
