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

function KanbanCardContent({
  account,
  stageLabel,
}: {
  account: AccountRow;
  stageLabel: string;
}) {
  return (
    <>
      <span
        className={`${styles.badge} ${styles.kanbanCardTag} ${tenantStatusBadgeClass(account.status)}`}
      >
        {stageLabel}
      </span>
      <strong className={styles.kanbanCardTitle}>{account.name}</strong>
      <div className={styles.kanbanCardFooter}>
        <span className={styles.kanbanCardMeta}>
          {formatPhoneDisplay(account.phone) ?? account.slug}
        </span>
        <span className={styles.kanbanCardAvatar} aria-hidden="true">
          {accountInitials(account.name)}
        </span>
      </div>
      <time className={styles.kanbanCardDate} dateTime={account.created_at}>
        Added {formatShortDate(account.created_at)}
      </time>
    </>
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
    <Link
      ref={setNodeRef}
      href={`/admin/accounts/${account.id}`}
      className={`${styles.kanbanCard} ${isDragging ? styles.kanbanCardDragging : ""}`}
      style={style}
      {...listeners}
      {...attributes}
    >
      <KanbanCardContent account={account} stageLabel={stageLabel} />
    </Link>
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
        className={`${styles.kanbanColumnBody} ${isOver ? styles.kanbanColumnBodyOver : ""}`}
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

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={closestCenter}
      onDragStart={handleDragStart}
      onDragEnd={handleDragEnd}
      onDragCancel={handleDragCancel}
    >
      <div
        className={styles.kanbanBoard}
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
            <KanbanCardContent account={activeAccount} stageLabel={activeStageLabel} />
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
