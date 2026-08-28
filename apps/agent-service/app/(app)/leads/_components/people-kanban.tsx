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
import {
  updateContactTypeAction,
  updateLeadStatusAction,
} from "@/lib/crm/crm-actions";
import {
  CONTACT_TYPE_OPTIONS,
  DEFAULT_CONTACT_TYPE,
  formatContactTypeLabel,
  type ContactType,
} from "@/lib/crm/contact-type";
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

const CONTACT_TYPE_BADGE_CLASS: Record<ContactType, string> = {
  Prospect: styles.badgeLeadNew,
  Customer: styles.badgeLeadQualified,
  "Inactive Customer": styles.badgeLeadConverted,
  Partner: styles.badgeLeadContacted,
  Vendor: styles.badgeLeadWorking,
};

type ColumnOption = { value: string; label: string };

interface PeopleKanbanProps {
  columns: Record<string, LeadRow[]>;
  kind?: PersonKind;
}

function columnOptionsForKind(kind: PersonKind): ColumnOption[] {
  return kind === "contact"
    ? CONTACT_TYPE_OPTIONS.map((option) => ({
        value: option.value,
        label: option.label,
      }))
    : LEAD_STATUS_OPTIONS.map((option) => ({
        value: option.value,
        label: option.label,
      }));
}

function cardColumnKey(lead: LeadRow, kind: PersonKind): string {
  if (kind === "contact") {
    return lead.contactType ?? DEFAULT_CONTACT_TYPE;
  }
  return lead.leadStatus;
}

function findLead(
  columns: Record<string, LeadRow[]>,
  columnOptions: ColumnOption[],
  leadId: string,
): LeadRow | null {
  for (const column of columnOptions) {
    const match = columns[column.value]?.find((row) => row.id === leadId);
    if (match) return match;
  }
  return null;
}

function moveLead(
  columns: Record<string, LeadRow[]>,
  columnOptions: ColumnOption[],
  leadId: string,
  toColumn: string,
  kind: PersonKind,
): Record<string, LeadRow[]> {
  let moved: LeadRow | undefined;

  const next = columnOptions.reduce(
    (acc, column) => {
      acc[column.value] = (columns[column.value] ?? []).filter((row) => {
        if (row.id === leadId) {
          moved = row;
          return false;
        }
        return true;
      });
      return acc;
    },
    {} as Record<string, LeadRow[]>,
  );

  if (moved) {
    const updated: LeadRow =
      kind === "contact"
        ? {
            ...moved,
            contactType: toColumn as ContactType,
          }
        : {
            ...moved,
            leadStatus: toColumn as LeadStatus,
            leadStatusLabel:
              LEAD_STATUS_OPTIONS.find((option) => option.value === toColumn)?.label ??
              toColumn,
          };
    next[toColumn] = [...(next[toColumn] ?? []), updated];
  }

  return next;
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

function CardTypeBadge({ lead, kind }: { lead: LeadRow; kind: PersonKind }) {
  if (kind === "contact") {
    const type = lead.contactType ?? DEFAULT_CONTACT_TYPE;
    return (
      <span className={`${styles.badge} ${styles.kanbanCardTag} ${CONTACT_TYPE_BADGE_CLASS[type]}`}>
        {formatContactTypeLabel(type)}
      </span>
    );
  }

  return (
    <span
      className={`${styles.badge} ${styles.kanbanCardTag} ${STATUS_BADGE_CLASS[lead.leadStatus]}`}
    >
      {lead.leadStatusLabel}
    </span>
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
        <CardTypeBadge lead={lead} kind={kind} />
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
  stage: ColumnOption;
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
    data: { column: cardColumnKey(lead, kind) },
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
  stage: ColumnOption;
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
  const columnOptions = columnOptionsForKind(kind);
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

  const activeLead = activeId ? findLead(columns, columnOptions, activeId) : null;

  function handleDragStart(event: DragStartEvent) {
    setActiveId(String(event.active.id));
  }

  function handleDragEnd(event: DragEndEvent) {
    setActiveId(null);

    const leadId = String(event.active.id);
    const overId = event.over?.id;
    const nextColumn = String(overId ?? "");
    const valid = columnOptions.some((option) => option.value === nextColumn);

    if (!valid) return;

    const lead = findLead(columns, columnOptions, leadId);
    if (!lead || cardColumnKey(lead, kind) === nextColumn) return;

    const previousColumns = columns;
    setColumns(moveLead(columns, columnOptions, leadId, nextColumn, kind));

    startTransition(async () => {
      const result =
        kind === "contact"
          ? await updateContactTypeAction(leadId, nextColumn)
          : await updateLeadStatusAction(leadId, nextColumn);
      if (!result.ok) {
        console.error(result.error ?? "Could not update.");
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
        {columnOptions.map((stage) => (
          <KanbanColumnStatic
            key={stage.value}
            stage={stage}
            cards={columns[stage.value] ?? []}
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
        {columnOptions.map((stage) => (
          <KanbanColumn
            key={stage.value}
            stage={stage}
            cards={columns[stage.value] ?? []}
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
