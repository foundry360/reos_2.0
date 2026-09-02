"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, useTransition, type ReactNode } from "react";
import { NewOpportunityModal } from "./new-opportunity-modal";
import { OpportunityAdditionalInfoCard, OpportunityDetailsCard } from "./opportunity-details-card";
import { NewActivityModal } from "../../leads/_components/new-activity-modal";
import { NewTaskModal } from "../../tasks/_components/new-task-modal";
import { ExpandableTasksList } from "../../tasks/_components/expandable-tasks-list";
import { EmptyState } from "@/components/shell/empty-state";
import {
  OPPORTUNITY_PRIORITY_COLORS,
  type OpportunityPriority,
} from "@/lib/opportunities/opportunity-fields";
import {
  stagesForPipeline,
  type OpportunityStage,
} from "@/lib/opportunities/opportunity-stages";
import type { OpportunityRow } from "@/lib/opportunities/opportunities-types";
import type {
  PersonActivityItem,
  PersonTaskSummary,
} from "@/lib/crm/person-activities";
import { updateOpportunityStageAction } from "@/lib/crm/crm-actions";
import { displayValue } from "@/lib/display-value";
import {
  ActivityDateFeed,
} from "@/components/shell/activity-date-feed";
import { IconOpportunities } from "@/components/shell/sidebar-nav";
import { useEmailCompose } from "@/components/email/email-compose-provider";
import { contactPrefillRecipient } from "@/lib/email/email-utils";
import emailStyles from "@/components/email/email.module.css";
import styles from "@/components/shell/shell.module.css";

interface SelectOption {
  id: string;
  label: string;
}

type FeedTab = "activities" | "notes" | "tasks" | "meetings";

function formatUsd(cents: number | null): string {
  if (cents == null) return displayValue(null);
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 0,
  }).format(cents / 100);
}

function formatLongDate(value: string | null): string {
  if (!value) return displayValue(null);
  return new Intl.DateTimeFormat("en-US", {
    month: "long",
    day: "numeric",
  }).format(new Date(`${value}T12:00:00`));
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

function IconBack() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path
        d="M15 18l-6-6 6-6"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function IconActivities() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path
        d="M4 6h16M4 12h10M4 18h14"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
      />
      <circle cx="18" cy="12" r="2" fill="currentColor" />
    </svg>
  );
}

function IconNote() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path
        d="M4 4h12l4 4v12H4V4z"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinejoin="round"
      />
      <path d="M16 4v4h4" stroke="currentColor" strokeWidth="2" strokeLinejoin="round" />
    </svg>
  );
}

function IconTask() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path
        d="M9 11l3 3L22 4"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
      />
    </svg>
  );
}

function IconMeeting() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <rect x="3" y="5" width="18" height="16" rx="2" stroke="currentColor" strokeWidth="2" />
      <path d="M8 3v4M16 3v4M3 10h18" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    </svg>
  );
}

function IconSearch() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <circle cx="11" cy="11" r="6.5" stroke="currentColor" strokeWidth="2" />
      <path d="M16 16l4 4" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    </svg>
  );
}

function PriorityPill({ priority }: { priority: OpportunityPriority | null }) {
  if (!priority) return <span className={styles.dealMetaPill}>N/A</span>;
  return (
    <span className={styles.dealMetaPill}>
      <span
        className={styles.optionColorDot}
        style={{ backgroundColor: OPPORTUNITY_PRIORITY_COLORS[priority], marginRight: 6 }}
        aria-hidden
      />
      {priority}
    </span>
  );
}

function EmptyBlock({ title, description }: { title: string; description: string }) {
  return (
    <div className={styles.dealActivityEmpty}>
      <p className={styles.personEmptyTitle}>{title}</p>
      <p className={styles.personEmptyText}>{description}</p>
    </div>
  );
}

function ActivityFeed({ activities }: { activities: PersonActivityItem[] }) {
  if (activities.length === 0) {
    return (
      <EmptyBlock
        title="No activities yet"
        description="Notes, calls, emails, and stage changes for this deal will appear here."
      />
    );
  }

  return (
    <ActivityDateFeed
      activities={activities}
      timeTitle={formatActivityTime}
    />
  );
}

const FEED_TABS: { id: FeedTab; label: string; icon: ReactNode }[] = [
  { id: "activities", label: "Activities", icon: <IconActivities /> },
  { id: "notes", label: "Notes", icon: <IconNote /> },
  { id: "tasks", label: "Tasks", icon: <IconTask /> },
  { id: "meetings", label: "Meetings", icon: <IconMeeting /> },
];

export function OpportunityDetailView({
  opportunity,
  agentLabel,
  contactOptions,
  agentOptions,
  activities,
  tasks,
}: {
  opportunity: OpportunityRow;
  agentLabel: string | null;
  contactOptions: SelectOption[];
  agentOptions: SelectOption[];
  activities: PersonActivityItem[];
  tasks: PersonTaskSummary[];
}) {
  const router = useRouter();
  const { openCompose } = useEmailCompose();
  const [feedTab, setFeedTab] = useState<FeedTab>("activities");
  const [feedQuery, setFeedQuery] = useState("");
  const [pending, startTransition] = useTransition();
  const [stageError, setStageError] = useState<string | null>(null);

  const stages = stagesForPipeline(opportunity.pipeline);
  const currentIndex = stages.findIndex((stage) => stage.value === opportunity.stage);
  const noteActivities = activities.filter(
    (item) => item.source === "activity" && item.type === "note",
  );
  const query = feedQuery.trim().toLowerCase();

  function matchesActivity(item: PersonActivityItem): boolean {
    if (!query) return true;
    return (
      item.title.toLowerCase().includes(query) ||
      (item.body?.toLowerCase().includes(query) ?? false) ||
      item.typeLabel.toLowerCase().includes(query)
    );
  }

  function matchesTask(item: PersonTaskSummary): boolean {
    if (!query) return true;
    return (
      item.title.toLowerCase().includes(query) ||
      (item.notes?.toLowerCase().includes(query) ?? false)
    );
  }

  const filteredActivities = activities.filter(matchesActivity);
  const filteredNotes = noteActivities.filter(matchesActivity);
  const filteredTasks = tasks.filter(matchesTask);
  const contactOption =
    opportunity.contactId && opportunity.contactName
      ? [{ id: opportunity.contactId, label: opportunity.contactName }]
      : [];

  const addNote = opportunity.contactId ? (
    <NewActivityModal
      contactId={opportunity.contactId}
      opportunityId={opportunity.id}
      defaultActivityType="note"
      lockActivityType
      trigger="cta"
      linkLabel="Add the first one"
    />
  ) : null;

  const addNoteSecondary = opportunity.contactId ? (
    <NewActivityModal
      contactId={opportunity.contactId}
      opportunityId={opportunity.id}
      defaultActivityType="note"
      lockActivityType
      trigger="secondary"
      linkLabel="Add"
    />
  ) : null;

  const addTask = (
    <NewTaskModal
      leadOptions={contactOption}
      agentOptions={agentOptions}
      defaultContactId={opportunity.contactId ?? undefined}
      lockContact={Boolean(opportunity.contactId)}
      opportunityId={opportunity.id}
      trigger="cta"
      linkLabel="Add the first one"
    />
  );

  const addTaskSecondary = (
    <NewTaskModal
      leadOptions={contactOption}
      agentOptions={agentOptions}
      defaultContactId={opportunity.contactId ?? undefined}
      lockContact={Boolean(opportunity.contactId)}
      opportunityId={opportunity.id}
      trigger="secondary"
      linkLabel="Add"
    />
  );

  const feedAction =
    !query && feedTab === "notes" && filteredNotes.length > 0
      ? addNoteSecondary
      : !query && feedTab === "tasks" && filteredTasks.length > 0
        ? addTaskSecondary
        : null;

  function setStage(next: OpportunityStage) {
    if (next === opportunity.stage || pending) return;
    setStageError(null);
    startTransition(async () => {
      const result = await updateOpportunityStageAction(opportunity.id, next);
      if (!result.ok) {
        setStageError(result.error ?? "Could not update stage.");
        return;
      }
      router.refresh();
    });
  }

  function composeEmail() {
    if (!opportunity.contactId || !opportunity.contactEmail) return;
    openCompose(
      {
        contactId: opportunity.contactId,
        contactName: opportunity.contactName ?? undefined,
        contactEmail: opportunity.contactEmail,
        opportunityId: opportunity.id,
        opportunityName: opportunity.name,
      },
      {
        to: contactPrefillRecipient(
          opportunity.contactName ?? "",
          opportunity.contactEmail,
        ),
      },
    );
  }

  return (
    <div className={styles.dealDetailPage}>
      <div className={styles.dealDetailNav}>
        <Link href="/opportunities" className={styles.personDetailBack}>
          <IconBack />
          Opportunities
        </Link>
      </div>

      <header className={styles.dealDetailHeader}>
        <div className={styles.dealDetailTitleRow}>
          <span
            className={`${styles.pageTitleIcon} ${styles.pageTitleIconOpportunity}`}
            aria-hidden
          >
            <IconOpportunities />
          </span>
          <h1 className={styles.dealDetailTitle}>{opportunity.name}</h1>
        </div>
        <div className={styles.dealDetailHeaderActions}>
          {opportunity.contactId && opportunity.contactEmail ? (
            <button
              type="button"
              className={emailStyles.widgetPrimaryBtn}
              onClick={composeEmail}
            >
              Send Email
            </button>
          ) : null}
          <NewOpportunityModal
            contactOptions={contactOptions}
            agentOptions={agentOptions}
            defaultContactId={opportunity.contactId ?? undefined}
          />
        </div>
      </header>

      <section className={`${styles.dealCard} ${styles.dealPipelineCard}`}>
            <div className={styles.dealPipelineTop}>
              <div className={styles.dealMetaPills}>
                <PriorityPill priority={opportunity.priority} />
                <span className={styles.dealMetaPill}>
                  {formatUsd(opportunity.amountCents)}
                </span>
                <span className={styles.dealMetaPill}>
                  {formatLongDate(opportunity.expectedCloseDate)}
                </span>
              </div>
            </div>

            <ol className={styles.dealPipelineTrack} aria-label="Pipeline stages">
              {stages.map((stage, index) => {
                const active = currentIndex >= 0 && index <= currentIndex;
                return (
                  <li
                    key={stage.value}
                    className={`${styles.dealPipelineStep} ${
                      active ? styles.dealPipelineStepActive : ""
                    }`}
                  >
                    <button
                      type="button"
                      className={styles.dealPipelineStepBtn}
                      disabled={pending}
                      onClick={() => setStage(stage.value)}
                    >
                      {stage.label}
                    </button>
                  </li>
                );
              })}
            </ol>
            {stageError ? <p className={styles.menuError}>{stageError}</p> : null}
          </section>

          <div className={styles.dealDetailLayout}>
            <div className={styles.dealDetailMain}>
              <section className={`${styles.dealCard} ${styles.dealActivityCard}`}>
                <div className={styles.dealFeedHeader}>
                  <div
                    className={styles.personDetailTabs}
                    role="tablist"
                    aria-label="Opportunity feed"
                  >
                    {FEED_TABS.map((item) => (
                      <button
                        key={item.id}
                        type="button"
                        role="tab"
                        aria-selected={feedTab === item.id}
                        className={`${styles.personDetailTab} ${
                          feedTab === item.id ? styles.personDetailTabActive : ""
                        }`}
                        onClick={() => setFeedTab(item.id)}
                      >
                        <span className={styles.personDetailTabIcon}>{item.icon}</span>
                        {item.label}
                      </button>
                    ))}
                  </div>
                  <label className={styles.dealFeedSearch}>
                    <span className={styles.dealFeedSearchIcon} aria-hidden>
                      <IconSearch />
                    </span>
                    <input
                      type="search"
                      className={styles.dealFeedSearchInput}
                      placeholder="Search activities"
                      value={feedQuery}
                      onChange={(event) => setFeedQuery(event.target.value)}
                      aria-label="Search activities"
                    />
                  </label>
                  {feedAction ? (
                    <div className={styles.dealFeedAction}>{feedAction}</div>
                  ) : null}
                </div>

                {feedTab === "activities" ? (
                  filteredActivities.length > 0 ? (
                    <ActivityFeed activities={filteredActivities} />
                  ) : (
                    <EmptyBlock
                      title={query ? "No matching activities" : "No activities yet"}
                      description={
                        query
                          ? "Try a different search term."
                          : "Notes, calls, emails, and stage changes for this deal will appear here."
                      }
                    />
                  )
                ) : null}
                {feedTab === "notes" ? (
                  filteredNotes.length > 0 ? (
                    <ActivityFeed activities={filteredNotes} />
                  ) : query ? (
                    <EmptyBlock
                      title="No matching notes"
                      description="Try a different search term."
                    />
                  ) : (
                    <div className={styles.dealFeedEmptyState}>
                      <EmptyState
                        title="Top sellers capture notes early"
                        description="Keep deal context in one place so nothing gets lost."
                        action={
                          addNote ?? (
                            <p className={styles.personEmptyText}>
                              Link a client to this opportunity to add notes.
                            </p>
                          )
                        }
                      />
                    </div>
                  )
                ) : null}
                {feedTab === "tasks" ? (
                  filteredTasks.length > 0 ? (
                    <ExpandableTasksList tasks={filteredTasks} variant="deal" />
                  ) : query ? (
                    <EmptyBlock
                      title="No matching tasks"
                      description="Try a different search term."
                    />
                  ) : (
                    <div className={styles.dealFeedEmptyState}>
                      <EmptyState
                        title="Top sellers stay on top of follow-ups"
                        description="Create tasks so every next step on this deal has an owner."
                        action={addTask}
                      />
                    </div>
                  )
                ) : null}
                {feedTab === "meetings" ? (
                  <EmptyBlock
                    title={query ? "No matching meetings" : "No meetings yet"}
                    description={
                      query
                        ? "Try a different search term."
                        : "Scheduled meetings for this opportunity will appear here."
                    }
                  />
                ) : null}
              </section>
            </div>

            <aside className={styles.dealDetailSidebar}>
              <OpportunityDetailsCard
                opportunity={opportunity}
                contactOptions={contactOptions}
                agentOptions={agentOptions}
                agentLabel={agentLabel}
              />
              <OpportunityAdditionalInfoCard />
            </aside>
          </div>
    </div>
  );
}
