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
import { OpportunityRowActions } from "./opportunity-row-actions";
import { updateOpportunityStageAction } from "@/lib/crm/crm-actions";
import {
  INTAKE_STAGE_OPTIONS,
  type OpportunityStage,
} from "@/lib/opportunities/opportunity-stages";
import type { OpportunityRow } from "@/lib/opportunities/opportunities-types";
import {
  OPPORTUNITY_PRIORITY_COLORS,
  type OpportunityPriority,
} from "@/lib/opportunities/opportunity-fields";
import { displayValue } from "@/lib/display-value";
import { accountInitials } from "@/lib/user-display";
import styles from "@/components/shell/shell.module.css";

const STAGE_BADGE_CLASS: Record<OpportunityStage, string> = {
  New: styles.badgeLeadNew,
  AI_Qualifying: styles.badgeLeadWorking,
  Qualified: styles.badgeLeadQualified,
  Appointment_Set: styles.badgeLeadContacted,
  Nurture: styles.badgeLeadWorking,
  Closed_Won: styles.badgeLeadConverted,
};

function PriorityLabel({ priority }: { priority: OpportunityPriority | null }) {
  if (!priority) return null;
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

interface OpportunitiesKanbanProps {
  columns: Record<OpportunityStage, OpportunityRow[]>;
  contactOptions: SelectOption[];
  agentOptions: SelectOption[];
}

function formatUsd(cents: number | null): string {
  if (cents == null) return displayValue(null);
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 0,
  }).format(cents / 100);
}

function formatShortDate(iso: string): string {
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
  }).format(new Date(iso));
}

function findOpportunity(
  columns: Record<OpportunityStage, OpportunityRow[]>,
  opportunityId: string,
): OpportunityRow | null {
  for (const stage of INTAKE_STAGE_OPTIONS) {
    const match = columns[stage.value].find((row) => row.id === opportunityId);
    if (match) return match;
  }
  return null;
}

function moveOpportunity(
  columns: Record<OpportunityStage, OpportunityRow[]>,
  opportunityId: string,
  toStage: OpportunityStage,
): Record<OpportunityStage, OpportunityRow[]> {
  let moved: OpportunityRow | undefined;

  const next = INTAKE_STAGE_OPTIONS.reduce(
    (acc, stage) => {
      acc[stage.value] = columns[stage.value].filter((row) => {
        if (row.id === opportunityId) {
          moved = row;
          return false;
        }
        return true;
      });
      return acc;
    },
    {} as Record<OpportunityStage, OpportunityRow[]>,
  );

  if (moved) {
    next[toStage] = [
      ...next[toStage],
      {
        ...moved,
        stage: toStage,
        stageLabel:
          INTAKE_STAGE_OPTIONS.find((option) => option.value === toStage)?.label ?? toStage,
      },
    ];
  }

  return next;
}

function contactHref(row: OpportunityRow): string | null {
  if (!row.contactId) return null;
  if (row.contactRecordType === "contact") return `/contacts/${row.contactId}`;
  return `/leads/${row.contactId}`;
}

function OpportunityCardBody({
  opportunity,
  contactOptions,
  agentOptions,
  showActions = false,
}: {
  opportunity: OpportunityRow;
  contactOptions: SelectOption[];
  agentOptions: SelectOption[];
  showActions?: boolean;
}) {
  const contactUrl = contactHref(opportunity);

  return (
    <>
      <div className={styles.kanbanCardTop}>
        <span
          className={`${styles.badge} ${styles.kanbanCardTag} ${STAGE_BADGE_CLASS[opportunity.stage]}`}
        >
          {opportunity.stageLabel}
        </span>
        {showActions ? (
          <OpportunityRowActions
            opportunity={opportunity}
            contactOptions={contactOptions}
            agentOptions={agentOptions}
            stopDrag
          />
        ) : null}
      </div>
      <Link
        href={`/opportunities/${opportunity.id}`}
        className={styles.kanbanCardTitleLink}
        onPointerDown={(event) => event.stopPropagation()}
      >
        {opportunity.name}
      </Link>
      <div className={styles.kanbanCardContact}>
        {opportunity.contactName ? (
          <span className={styles.kanbanCardContactRow}>
            {contactUrl ? (
              <Link
                href={contactUrl}
                className={`${styles.kanbanCardContactText} ${styles.contactLink}`}
                onPointerDown={(event) => event.stopPropagation()}
              >
                {opportunity.contactName}
              </Link>
            ) : (
              <span className={styles.kanbanCardContactText}>
                {opportunity.contactName}
              </span>
            )}
          </span>
        ) : null}
        <span className={styles.kanbanCardContactRow}>
          <span className={styles.kanbanCardContactText}>
            {formatUsd(opportunity.amountCents)}
          </span>
          {opportunity.priority ? (
            <span className={styles.kanbanCardContactText}>
              <PriorityLabel priority={opportunity.priority} />
            </span>
          ) : null}
        </span>
      </div>
      <div className={styles.kanbanCardFooter}>
        <time className={styles.kanbanCardDate} dateTime={opportunity.updatedAt}>
          Updated {formatShortDate(opportunity.updatedAt)}
        </time>
        {opportunity.contactName ? (
          <span
            className={`${styles.kanbanCardAvatar} ${styles.personInitialsAvatar}`}
            title={opportunity.contactName}
            aria-label={opportunity.contactName}
          >
            {accountInitials(opportunity.contactName)}
          </span>
        ) : null}
      </div>
    </>
  );
}

function KanbanCardStatic({
  opportunity,
  contactOptions,
  agentOptions,
}: {
  opportunity: OpportunityRow;
  contactOptions: SelectOption[];
  agentOptions: SelectOption[];
}) {
  return (
    <div className={styles.kanbanCard}>
      <OpportunityCardBody
        opportunity={opportunity}
        contactOptions={contactOptions}
        agentOptions={agentOptions}
        showActions
      />
    </div>
  );
}

function KanbanCard({
  opportunity,
  contactOptions,
  agentOptions,
}: {
  opportunity: OpportunityRow;
  contactOptions: SelectOption[];
  agentOptions: SelectOption[];
}) {
  const { attributes, listeners, setNodeRef, transform, isDragging } = useDraggable({
    id: opportunity.id,
  });

  return (
    <div
      ref={setNodeRef}
      className={`${styles.kanbanCard} ${styles.kanbanCardDraggable} ${
        isDragging ? styles.kanbanCardDragging : ""
      }`}
      style={{ transform: CSS.Translate.toString(transform) }}
      {...listeners}
      {...attributes}
    >
      <OpportunityCardBody
        opportunity={opportunity}
        contactOptions={contactOptions}
        agentOptions={agentOptions}
        showActions
      />
    </div>
  );
}

function KanbanColumnStatic({
  stage,
  cards,
  contactOptions,
  agentOptions,
}: {
  stage: (typeof INTAKE_STAGE_OPTIONS)[number];
  cards: OpportunityRow[];
  contactOptions: SelectOption[];
  agentOptions: SelectOption[];
}) {
  return (
    <section className={styles.kanbanColumn}>
      <header className={styles.kanbanColumnHeader}>
        <h2 className={styles.kanbanColumnTitle}>{stage.label}</h2>
        <span className={styles.kanbanColumnCount}>{cards.length}</span>
      </header>
      <div className={`${styles.kanbanColumnBody} kanban-column-scroll`}>
        {cards.length === 0 ? (
          <p className={styles.kanbanEmpty}>No opportunities</p>
        ) : (
          cards.map((opportunity) => (
            <KanbanCardStatic
              key={opportunity.id}
              opportunity={opportunity}
              contactOptions={contactOptions}
              agentOptions={agentOptions}
            />
          ))
        )}
      </div>
    </section>
  );
}

function KanbanColumn({
  stage,
  cards,
  contactOptions,
  agentOptions,
}: {
  stage: (typeof INTAKE_STAGE_OPTIONS)[number];
  cards: OpportunityRow[];
  contactOptions: SelectOption[];
  agentOptions: SelectOption[];
}) {
  const { setNodeRef, isOver } = useDroppable({ id: stage.value });

  return (
    <section className={styles.kanbanColumn}>
      <header className={styles.kanbanColumnHeader}>
        <h2 className={styles.kanbanColumnTitle}>{stage.label}</h2>
        <span className={styles.kanbanColumnCount}>{cards.length}</span>
      </header>
      <div
        ref={setNodeRef}
        className={`${styles.kanbanColumnBody} kanban-column-scroll ${
          isOver ? styles.kanbanColumnBodyOver : ""
        }`}
      >
        {cards.length === 0 ? (
          <p className={styles.kanbanEmpty}>No opportunities</p>
        ) : (
          cards.map((opportunity) => (
            <KanbanCard
              key={opportunity.id}
              opportunity={opportunity}
              contactOptions={contactOptions}
              agentOptions={agentOptions}
            />
          ))
        )}
      </div>
    </section>
  );
}

export function OpportunitiesKanban({
  columns: initialColumns,
  contactOptions,
  agentOptions,
}: OpportunitiesKanbanProps) {
  const router = useRouter();
  const [mounted, setMounted] = useState(false);
  const [columns, setColumns] = useState(initialColumns);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

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

  const activeOpportunity = activeId ? findOpportunity(columns, activeId) : null;

  function handleDragStart(event: DragStartEvent) {
    setActiveId(String(event.active.id));
  }

  function handleDragEnd(event: DragEndEvent) {
    setActiveId(null);

    const opportunityId = String(event.active.id);
    const overId = event.over?.id;
    const nextStage = String(overId ?? "") as OpportunityStage;
    const valid = INTAKE_STAGE_OPTIONS.some((option) => option.value === nextStage);

    if (!valid) return;

    const opportunity = findOpportunity(columns, opportunityId);
    if (!opportunity || opportunity.stage === nextStage) return;

    const previousColumns = columns;
    setColumns(moveOpportunity(columns, opportunityId, nextStage));

    startTransition(async () => {
      const result = await updateOpportunityStageAction(opportunityId, nextStage);
      if (!result.ok) {
        console.error(result.error ?? "Could not update stage.");
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
      <div className={`${styles.kanbanBoard} kanban-board-scroll`} aria-busy={pending}>
        {INTAKE_STAGE_OPTIONS.map((stage) => (
          <KanbanColumnStatic
            key={stage.value}
            stage={stage}
            cards={columns[stage.value]}
            contactOptions={contactOptions}
            agentOptions={agentOptions}
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
        data-busy={pending ? "true" : undefined}
        aria-busy={pending}
      >
        {INTAKE_STAGE_OPTIONS.map((stage) => (
          <KanbanColumn
            key={stage.value}
            stage={stage}
            cards={columns[stage.value]}
            contactOptions={contactOptions}
            agentOptions={agentOptions}
          />
        ))}
      </div>
      <DragOverlay>
        {activeOpportunity ? (
          <div className={`${styles.kanbanCard} ${styles.kanbanCardOverlay}`}>
            <OpportunityCardBody
              opportunity={activeOpportunity}
              contactOptions={contactOptions}
              agentOptions={agentOptions}
            />
          </div>
        ) : null}
      </DragOverlay>
    </DndContext>
  );
}
