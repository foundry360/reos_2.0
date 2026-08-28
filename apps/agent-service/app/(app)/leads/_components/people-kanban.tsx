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
import { LeadRowActions } from "./lead-row-actions";
import { updateLeadStatusAction } from "@/lib/crm/crm-actions";
import {
  personBasePath,
  personPlural,
  type PersonKind,
} from "@/lib/crm/person-kind";
import { LEAD_STATUS_OPTIONS } from "@/lib/leads/lead-status";
import type { LeadStatus } from "@/lib/coordinator";
import type { LeadRow } from "@/lib/leads/leads-types";
import { formatPhoneDisplay } from "@/lib/phone-display";
import { accountInitials } from "@/lib/user-display";
import styles from "@/components/shell/shell.module.css";

const STATUS_BADGE_CLASS: Record<LeadStatus, string> = {
  New: styles.badgeLeadNew,
  Working: styles.badgeLeadWorking,
  Contacted: styles.badgeLeadContacted,
  Qualified: styles.badgeLeadQualified,
  Converted: styles.badgeLeadConverted,
};

interface PeopleKanbanProps {
  columns: Record<LeadStatus, LeadRow[]>;
  kind?: PersonKind;
}

function formatShortDate(iso: string): string {
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
  }).format(new Date(iso));
}

function findLead(
  columns: Record<LeadStatus, LeadRow[]>,
  leadId: string,
): LeadRow | null {
  for (const status of LEAD_STATUS_OPTIONS) {
    const match = columns[status.value].find((row) => row.id === leadId);
    if (match) return match;
  }
  return null;
}

function moveLead(
  columns: Record<LeadStatus, LeadRow[]>,
  leadId: string,
  toStatus: LeadStatus,
): Record<LeadStatus, LeadRow[]> {
  let moved: LeadRow | undefined;

  const next = LEAD_STATUS_OPTIONS.reduce(
    (acc, status) => {
      acc[status.value] = columns[status.value].filter((row) => {
        if (row.id === leadId) {
          moved = row;
          return false;
        }
        return true;
      });
      return acc;
    },
    {} as Record<LeadStatus, LeadRow[]>,
  );

  if (moved) {
    next[toStatus] = [
      ...next[toStatus],
      {
        ...moved,
        leadStatus: toStatus,
        leadStatusLabel:
          LEAD_STATUS_OPTIONS.find((option) => option.value === toStatus)?.label ?? toStatus,
      },
    ];
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
  lead,
  kind,
  linkTitle = true,
  showActions = false,
}: {
  lead: LeadRow;
  kind: PersonKind;
  linkTitle?: boolean;
  showActions?: boolean;
}) {
  const basePath = personBasePath(kind);
  const phone = formatPhoneDisplay(lead.phone);
  const email = lead.email?.trim() || null;

  return (
    <>
      <div className={styles.kanbanCardTop}>
        <span
          className={`${styles.badge} ${styles.kanbanCardTag} ${STATUS_BADGE_CLASS[lead.leadStatus]}`}
        >
          {lead.leadStatusLabel}
        </span>
        {showActions && <LeadRowActions lead={lead} kind={kind} stopDrag />}
      </div>
      {linkTitle ? (
        <Link
          href={`${basePath}/${lead.id}`}
          className={styles.kanbanCardTitleLink}
          onPointerDown={(event) => event.stopPropagation()}
        >
          {lead.name}
        </Link>
      ) : (
        <strong className={styles.kanbanCardTitle}>{lead.name}</strong>
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
        <time className={styles.kanbanCardDate} dateTime={lead.updatedAt}>
          Updated {formatShortDate(lead.updatedAt)}
        </time>
        <span className={styles.kanbanCardAvatar} aria-hidden="true">
          {accountInitials(lead.name)}
        </span>
      </div>
    </>
  );
}

function KanbanCardStatic({ lead, kind }: { lead: LeadRow; kind: PersonKind }) {
  return (
    <div className={styles.kanbanCard}>
      <KanbanCardContent lead={lead} kind={kind} showActions />
    </div>
  );
}

function KanbanColumnStatic({
  stage,
  cards,
  kind,
  emptyLabel,
}: {
  stage: (typeof LEAD_STATUS_OPTIONS)[number];
  cards: LeadRow[];
  kind: PersonKind;
  emptyLabel: string;
}) {
  return (
    <section className={styles.kanbanColumn}>
      <header className={styles.kanbanColumnHeader}>
        <h2 className={styles.kanbanColumnTitle}>{stage.label}</h2>
        <span className={styles.kanbanColumnCount}>{cards.length}</span>
      </header>
      <div className={`${styles.kanbanColumnBody} kanban-column-scroll`}>
        {cards.length === 0 ? (
          <p className={styles.kanbanEmpty}>{emptyLabel}</p>
        ) : (
          cards.map((lead) => <KanbanCardStatic key={lead.id} lead={lead} kind={kind} />)
        )}
      </div>
    </section>
  );
}

function KanbanCard({ lead, kind }: { lead: LeadRow; kind: PersonKind }) {
  const { attributes, listeners, setNodeRef, transform, isDragging } = useDraggable({
    id: lead.id,
    data: { status: lead.leadStatus },
  });

  const style = transform ? { transform: CSS.Translate.toString(transform) } : undefined;

  return (
    <div
      ref={setNodeRef}
      className={`${styles.kanbanCard} ${styles.kanbanCardDraggable} ${isDragging ? styles.kanbanCardDragging : ""}`}
      style={style}
      {...listeners}
      {...attributes}
    >
      <KanbanCardContent lead={lead} kind={kind} showActions />
    </div>
  );
}

function KanbanColumn({
  stage,
  cards,
  kind,
  emptyLabel,
}: {
  stage: (typeof LEAD_STATUS_OPTIONS)[number];
  cards: LeadRow[];
  kind: PersonKind;
  emptyLabel: string;
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
          <p className={styles.kanbanEmpty}>{emptyLabel}</p>
        ) : (
          cards.map((lead) => <KanbanCard key={lead.id} lead={lead} kind={kind} />)
        )}
      </div>
    </section>
  );
}

export function PeopleKanban({ columns: initialColumns, kind = "lead" }: PeopleKanbanProps) {
  const router = useRouter();
  const plural = personPlural(kind);
  const emptyLabel = `No ${plural}`;
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

  const activeLead = activeId ? findLead(columns, activeId) : null;

  function handleDragStart(event: DragStartEvent) {
    setActiveId(String(event.active.id));
  }

  function handleDragEnd(event: DragEndEvent) {
    setActiveId(null);

    const leadId = String(event.active.id);
    const overId = event.over?.id;
    const nextStatus = String(overId ?? "") as LeadStatus;
    const valid = LEAD_STATUS_OPTIONS.some((option) => option.value === nextStatus);

    if (!valid) return;

    const lead = findLead(columns, leadId);
    if (!lead || lead.leadStatus === nextStatus) return;

    const previousColumns = columns;
    setColumns(moveLead(columns, leadId, nextStatus));

    startTransition(async () => {
      const result = await updateLeadStatusAction(leadId, nextStatus);
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
        {LEAD_STATUS_OPTIONS.map((stage) => (
          <KanbanColumnStatic
            key={stage.value}
            stage={stage}
            cards={columns[stage.value]}
            kind={kind}
            emptyLabel={emptyLabel}
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
        {LEAD_STATUS_OPTIONS.map((stage) => (
          <KanbanColumn
            key={stage.value}
            stage={stage}
            cards={columns[stage.value]}
            kind={kind}
            emptyLabel={emptyLabel}
          />
        ))}
      </div>

      <DragOverlay dropAnimation={null}>
        {activeLead ? (
          <div className={`${styles.kanbanCard} ${styles.kanbanCardOverlay}`}>
            <KanbanCardContent lead={activeLead} kind={kind} linkTitle={false} />
          </div>
        ) : null}
      </DragOverlay>
    </DndContext>
  );
}
