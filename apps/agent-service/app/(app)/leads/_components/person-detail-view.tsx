"use client";

import Link from "next/link";
import { useState, type ReactNode } from "react";
import {
  personBasePath,
  personPlural,
  personSingularTitle,
} from "@/lib/crm/person-kind";
import { displayValue } from "@/lib/display-value";
import { accountInitials } from "@/lib/user-display";
import { formatRelativeTime } from "@/lib/admin/activity-timeline";
import styles from "@/components/shell/shell.module.css";
import { PersonAboutCard } from "./person-about-card";
import { PersonMessagingPanel } from "./person-messaging-thread";
import type {
  PersonActivityItem,
  PersonDetailData,
  PersonOpportunitySummary,
} from "../_lib/person-detail-types";
import { NewActivityModal } from "./new-activity-modal";
import { NewOpportunityModal } from "../../opportunities/_components/new-opportunity-modal";
import { NewTaskModal } from "../../tasks/_components/new-task-modal";
import { ExpandableTasksList } from "../../tasks/_components/expandable-tasks-list";
import { EmptyState } from "@/components/shell/empty-state";
import {
  ActivityDateFeed,
  ActivityTypeIcon,
} from "@/components/shell/activity-date-feed";

export type { PersonDetailData };

type DetailTab = "overview" | "activities" | "messaging" | "notes" | "tasks";

interface AgentOption {
  id: string;
  label: string;
}

function formatUsd(cents: number | null): string {
  if (cents == null) return displayValue(null);
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 0,
  }).format(cents / 100);
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

function IconCopy() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <rect x="9" y="9" width="11" height="11" rx="2" stroke="currentColor" strokeWidth="2" />
      <path
        d="M5 15V5a2 2 0 0 1 2-2h10"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
      />
    </svg>
  );
}

function IconOverview() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <rect x="3" y="3" width="8" height="8" rx="1.5" stroke="currentColor" strokeWidth="2" />
      <rect x="13" y="3" width="8" height="5" rx="1.5" stroke="currentColor" strokeWidth="2" />
      <rect x="13" y="10" width="8" height="11" rx="1.5" stroke="currentColor" strokeWidth="2" />
      <rect x="3" y="13" width="8" height="8" rx="1.5" stroke="currentColor" strokeWidth="2" />
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

function IconMessaging() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path
        d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinejoin="round"
      />
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

function IconEmail() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <rect x="3" y="5" width="18" height="14" rx="2" stroke="currentColor" strokeWidth="2" />
      <path d="M3 7l9 7 9-7" stroke="currentColor" strokeWidth="2" strokeLinejoin="round" />
    </svg>
  );
}

function IconCall() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden="true">
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

function IconMore() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <circle cx="5" cy="12" r="1.5" fill="currentColor" />
      <circle cx="12" cy="12" r="1.5" fill="currentColor" />
      <circle cx="19" cy="12" r="1.5" fill="currentColor" />
    </svg>
  );
}

function AccordionChevron({ open }: { open: boolean }) {
  return (
    <svg
      className={`${styles.accordionChevron} ${open ? styles.accordionChevronOpen : ""}`}
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      aria-hidden="true"
    >
      <path
        d="M6 9l6 6 6-6"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function EmptyBlock({ title, description }: { title: string; description: string }) {
  return (
    <div className={styles.personEmptyBlock}>
      <p className={styles.personEmptyTitle}>{title}</p>
      <p className={styles.personEmptyText}>{description}</p>
    </div>
  );
}

function ActivityList({
  activities,
  limit,
}: {
  activities: PersonActivityItem[];
  limit?: number;
}) {
  const rows = limit != null ? activities.slice(0, limit) : activities;
  return (
    <ul className={styles.personLinkedList}>
      {rows.map((activity) => {
        const content = (
          <>
            <ActivityTypeIcon type={activity.type} />
            <span className={styles.personLinkedItemMain}>
              <span className={styles.personLinkedItemTitle}>{activity.title}</span>
              <span className={styles.personLinkedItemMeta}>
                {activity.typeLabel}
                {activity.body ? ` · ${activity.body}` : ""}
              </span>
            </span>
            <time className={styles.personLinkedItemTime} dateTime={activity.occurredAt}>
              {formatRelativeTime(activity.occurredAt)}
            </time>
          </>
        );

        return (
          <li key={activity.id}>
            {activity.href ? (
              <Link href={activity.href} className={styles.personLinkedItem}>
                {content}
              </Link>
            ) : (
              <div className={styles.personLinkedItem}>{content}</div>
            )}
          </li>
        );
      })}
    </ul>
  );
}

function OpportunityList({
  opportunities,
  compact = false,
}: {
  opportunities: PersonOpportunitySummary[];
  compact?: boolean;
}) {
  return (
    <ul className={compact ? styles.personAssociationList : styles.personLinkedList}>
      {opportunities.map((opportunity) => (
        <li key={opportunity.id}>
          <Link
            href={`/opportunities/${opportunity.id}`}
            className={compact ? styles.personAssociationItem : styles.personLinkedItem}
          >
            <ActivityTypeIcon type="opportunity" />
            <span className={compact ? styles.personAssociationItemMain : styles.personLinkedItemMain}>
              <span className={compact ? styles.personAssociationItemTitle : styles.personLinkedItemTitle}>
                {opportunity.name}
              </span>
              <span className={compact ? styles.personAssociationItemMeta : styles.personLinkedItemMeta}>
                {opportunity.stageLabel}
                {opportunity.amountCents != null ? ` · ${formatUsd(opportunity.amountCents)}` : ""}
              </span>
            </span>
            {!compact ? (
              <time
                className={styles.personLinkedItemTime}
                dateTime={opportunity.updatedAt}
              >
                {formatRelativeTime(opportunity.updatedAt)}
              </time>
            ) : null}
          </Link>
        </li>
      ))}
    </ul>
  );
}

const QUICK_ACTIONS = [
  { id: "note", label: "Note", icon: <IconNote /> },
  { id: "email", label: "Email", icon: <IconEmail /> },
  { id: "call", label: "Call", icon: <IconCall /> },
  { id: "task", label: "Task", icon: <IconTask /> },
  { id: "meeting", label: "Meeting", icon: <IconMeeting /> },
  { id: "more", label: "More", icon: <IconMore /> },
] as const;

const DETAIL_TABS: { id: DetailTab; label: string; icon: ReactNode }[] = [
  { id: "overview", label: "Overview", icon: <IconOverview /> },
  { id: "activities", label: "Activities", icon: <IconActivities /> },
  { id: "messaging", label: "Messaging", icon: <IconMessaging /> },
  { id: "notes", label: "Notes", icon: <IconNote /> },
  { id: "tasks", label: "Tasks", icon: <IconTask /> },
];

export function PersonDetailView({
  person,
  agentOptions = [],
  currentUser,
}: {
  person: PersonDetailData;
  agentOptions?: AgentOption[];
  currentUser?: { displayName: string; avatarUrl: string | null };
}) {
  const [tab, setTab] = useState<DetailTab>("overview");
  const [summaryOpen, setSummaryOpen] = useState(true);
  const singular = personSingularTitle(person.kind);
  const plural = personPlural(person.kind);
  const listHref = personBasePath(person.kind);
  const email = person.email?.trim() || null;

  const contactOption = { id: person.id, label: person.name };

  async function copyEmail() {
    if (!email || !navigator.clipboard) return;
    try {
      await navigator.clipboard.writeText(email);
    } catch {
      // ignore clipboard failures
    }
  }

  const addTask = (
    <NewTaskModal
      leadOptions={[contactOption]}
      agentOptions={agentOptions}
      defaultContactId={person.id}
      lockContact
      trigger="secondary"
      linkLabel="Add"
    />
  );

  const addTaskCta = (
    <NewTaskModal
      leadOptions={[contactOption]}
      agentOptions={agentOptions}
      defaultContactId={person.id}
      lockContact
      trigger="cta"
      linkLabel="Add the first one"
    />
  );

  const addNote = (
    <NewActivityModal
      contactId={person.id}
      defaultActivityType="note"
      lockActivityType
      trigger="secondary"
      linkLabel="Add Note"
    />
  );

  const addNoteCta = (
    <NewActivityModal
      contactId={person.id}
      defaultActivityType="note"
      lockActivityType
      trigger="cta"
      linkLabel="Add a Note"
    />
  );

  const addActivity = (
    <NewActivityModal
      contactId={person.id}
      trigger="secondary"
      linkLabel="Add"
    />
  );

  const addActivityCta = (
    <NewActivityModal
      contactId={person.id}
      trigger="cta"
      linkLabel="Log an Activity"
    />
  );

  const addOpportunity = (
    <NewOpportunityModal
      contactOptions={[contactOption]}
      agentOptions={agentOptions}
      defaultContactId={person.id}
      lockContact
      trigger="secondary"
      linkLabel="Add"
    />
  );

  return (
    <div
      className={`${styles.personDetailPage} ${
        tab === "messaging" ? styles.personDetailPageMessaging : ""
      }`}
    >
      <div className={styles.personDetailNav}>
        <Link href={listHref} className={styles.personDetailBack}>
          <IconBack />
          {plural.charAt(0).toUpperCase() + plural.slice(1)}
        </Link>
      </div>

      <div
        className={`${styles.personDetailLayout} ${
          tab === "messaging" ? styles.personDetailLayoutFill : ""
        }`}
      >
        <aside className={styles.personDetailLeft}>
          <section className={styles.personProfileCard}>
            <div className={styles.personProfileHeader}>
              <span className={`${styles.avatar} ${styles.personProfileAvatar}`}>
                {accountInitials(person.name)}
              </span>
              <div className={styles.personProfileMeta}>
                <h1 className={styles.personProfileName}>{person.name}</h1>
                <p className={styles.personProfileKind}>{singular}</p>
                {email ? (
                  <button
                    type="button"
                    className={styles.personProfileEmail}
                    onClick={copyEmail}
                    title="Copy email"
                  >
                    <span>{email}</span>
                    <IconCopy />
                  </button>
                ) : (
                  <p className={styles.personProfileEmailMuted}>{displayValue(null)}</p>
                )}
              </div>
            </div>

            <div className={styles.personQuickActions}>
              {QUICK_ACTIONS.map((action) => {
                if (action.id === "note") {
                  return (
                    <NewActivityModal
                      key={action.id}
                      contactId={person.id}
                      defaultActivityType="note"
                      lockActivityType
                      trigger="quickAction"
                      linkLabel="Note"
                      triggerIcon={action.icon}
                    />
                  );
                }
                if (action.id === "task") {
                  return (
                    <NewTaskModal
                      key={action.id}
                      leadOptions={[contactOption]}
                      agentOptions={agentOptions}
                      defaultContactId={person.id}
                      lockContact
                      trigger="quickAction"
                      linkLabel="Task"
                      triggerIcon={action.icon}
                    />
                  );
                }
                return (
                  <button
                    key={action.id}
                    type="button"
                    className={styles.personQuickAction}
                    disabled
                    title="Coming soon"
                  >
                    <span className={styles.personQuickActionIcon}>{action.icon}</span>
                    <span>{action.label}</span>
                  </button>
                );
              })}
            </div>
          </section>

          <PersonAboutCard person={person} />
        </aside>

        <main
          className={`${styles.personDetailCenter} ${
            tab === "messaging" ? styles.personDetailCenterMessaging : ""
          }`}
        >
          <div className={styles.personDetailTabs} role="tablist" aria-label={`${singular} sections`}>
            {DETAIL_TABS.map((item) => (
              <button
                key={item.id}
                type="button"
                role="tab"
                aria-selected={tab === item.id}
                className={`${styles.personDetailTab} ${
                  tab === item.id ? styles.personDetailTabActive : ""
                }`}
                onClick={() => setTab(item.id)}
              >
                <span className={styles.personDetailTabIcon}>{item.icon}</span>
                {item.label}
              </button>
            ))}
          </div>

          {tab === "overview" ? (
            <div className={styles.personDetailCenterStack} role="tabpanel">
              <section className={styles.personCenterCard}>
                <div className={styles.personHighlightsRow}>
                  <div className={styles.personHighlightItem}>
                    <span className={styles.personHighlightLabel}>Create date</span>
                    <span className={styles.personHighlightValue}>
                      {new Date(person.createdAt).toLocaleDateString()}
                    </span>
                  </div>
                  <div className={styles.personHighlightItem}>
                    <span className={styles.personHighlightLabel}>
                      {person.kind === "contact" ? "Contact type" : "Status"}
                    </span>
                    <span className={styles.personHighlightValue}>
                      {person.kind === "contact"
                        ? person.contactTypeLabel
                        : person.statusLabel}
                    </span>
                  </div>
                  <div className={styles.personHighlightItem}>
                    <span className={styles.personHighlightLabel}>Last activity</span>
                    <span className={styles.personHighlightValue}>
                      {formatRelativeTime(
                        person.activities[0]?.occurredAt ?? person.updatedAt,
                      )}
                    </span>
                  </div>
                </div>
              </section>

              <section className={styles.personCenterCard}>
                <div className={styles.personCenterCardHeader}>
                  <h2 className={styles.personCenterCardTitle}>Recent activities</h2>
                </div>
                {person.activities.length > 0 ? (
                  <ActivityList activities={person.activities} limit={5} />
                ) : (
                  <EmptyBlock
                    title="No activities yet"
                    description="Notes, calls, emails, and tasks for this record will appear here."
                  />
                )}
              </section>

              <section className={styles.personCenterCard}>
                <div className={styles.personCenterCardHeader}>
                  <h2 className={styles.personCenterCardTitle}>Opportunities</h2>
                  {addOpportunity}
                </div>
                {person.opportunities.length > 0 ? (
                  <OpportunityList opportunities={person.opportunities} />
                ) : (
                  <EmptyBlock
                    title="No associated opportunities"
                    description="Link deals and opportunities to this record to track progress."
                  />
                )}
              </section>

              <section className={styles.personCenterCard}>
                <div className={styles.personCenterCardHeader}>
                  <h2 className={styles.personCenterCardTitle}>Tasks</h2>
                  {addTask}
                </div>
                {person.tasks.length > 0 ? (
                  <ExpandableTasksList tasks={person.tasks} />
                ) : (
                  <EmptyBlock
                    title="No associated tasks"
                    description="Create follow-ups and to-dos tied to this record."
                  />
                )}
              </section>
            </div>
          ) : null}

          {tab === "activities" ? (
            <div className={styles.personDetailCenterStack} role="tabpanel">
              <section className={styles.personCenterCard}>
                <div className={styles.personCenterCardHeader}>
                  <h2 className={styles.personCenterCardTitle}>Activities</h2>
                  {person.activities.length > 0 ? addActivity : null}
                </div>
                {person.activities.length > 0 ? (
                  <ActivityDateFeed
                    activities={person.activities}
                    formatTime={formatRelativeTime}
                  />
                ) : (
                  <div className={styles.personFeedEmptyState}>
                    <EmptyState
                      title="Keep every touchpoint in one place"
                      description="Log notes, calls, emails, and meetings so the full story stays with this record."
                      action={addActivityCta}
                    />
                  </div>
                )}
              </section>
            </div>
          ) : null}

          {tab === "messaging" ? (
            <div className={styles.personMessagingFull} role="tabpanel">
              <PersonMessagingPanel
                contactId={person.id}
                personName={person.name}
                avatarUrl={person.avatarUrl}
                agentName={currentUser?.displayName}
                agentAvatarUrl={currentUser?.avatarUrl}
                messages={person.messages}
                channels={person.messagingChannels}
              />
            </div>
          ) : null}

          {tab === "notes" ? (
            <div className={styles.personDetailCenterStack} role="tabpanel">
              <section className={styles.personCenterCard}>
                <div className={styles.personCenterCardHeader}>
                  <h2 className={styles.personCenterCardTitle}>Notes</h2>
                  {person.activities.some(
                    (item) => item.source === "activity" && item.type === "note",
                  )
                    ? addNote
                    : null}
                </div>
                {person.activities.filter(
                  (item) => item.source === "activity" && item.type === "note",
                ).length > 0 ? (
                  <ActivityDateFeed
                    activities={person.activities.filter(
                      (item) => item.source === "activity" && item.type === "note",
                    )}
                    formatTime={formatRelativeTime}
                  />
                ) : (
                  <div className={styles.personFeedEmptyState}>
                    <EmptyState
                      title="Capture what matters"
                      description="Keep context and follow-ups for this record in one place."
                      action={addNoteCta}
                    />
                  </div>
                )}
              </section>
            </div>
          ) : null}

          {tab === "tasks" ? (
            <div className={styles.personDetailCenterStack} role="tabpanel">
              <section className={styles.personCenterCard}>
                <div className={styles.personCenterCardHeader}>
                  <h2 className={styles.personCenterCardTitle}>Tasks</h2>
                  {person.tasks.length > 0 ? addTask : null}
                </div>
                {person.tasks.length > 0 ? (
                  <ExpandableTasksList tasks={person.tasks} />
                ) : (
                  <div className={styles.personFeedEmptyState}>
                    <EmptyState
                      title="Stay on top of every follow-up"
                      description="Create tasks so every next step for this contact has an owner."
                      action={addTaskCta}
                    />
                  </div>
                )}
              </section>
            </div>
          ) : null}
        </main>

        <aside className={styles.personDetailRight}>
          <section className={`${styles.personSideCard} ${styles.personAiCard}`}>
            <button
              type="button"
              className={styles.personSideCardHeader}
              aria-expanded={summaryOpen}
              onClick={() => setSummaryOpen((open) => !open)}
            >
              <span className={styles.personAiCardTitle}>
                Record summary
                <span className={styles.personAiBadge}>AI</span>
              </span>
              <AccordionChevron open={summaryOpen} />
            </button>
            {summaryOpen && (
              <div className={styles.personSideCardBody}>
                {person.aiSummary ? (
                  <p className={styles.personAiSummary}>{person.aiSummary}</p>
                ) : (
                  <EmptyBlock
                    title="No summary yet"
                    description="AI will summarize this record once enough activity exists."
                  />
                )}
                <button type="button" className={styles.personAiAskBtn} disabled>
                  Ask A Question
                </button>
              </div>
            )}
          </section>

          <section className={styles.personSideCard}>
            <div className={styles.personSideCardHeaderStatic}>
              <span>Associations</span>
            </div>
            <div className={styles.personSideCardBody}>
              <div className={styles.personAssociationBlock}>
                <div className={styles.personAssociationHeader}>
                  <span>Companies (0)</span>
                  <button type="button" className={styles.tableFooterLink} disabled>
                    + Add
                  </button>
                </div>
                <p className={styles.personAssociationEmpty}>No companies linked yet.</p>
              </div>
              <div className={styles.personAssociationBlock}>
                <div className={styles.personAssociationHeader}>
                  <span>Opportunities ({person.opportunities.length})</span>
                </div>
                {person.opportunities.length > 0 ? (
                  <OpportunityList opportunities={person.opportunities} compact />
                ) : (
                  <p className={styles.personAssociationEmpty}>No opportunities linked yet.</p>
                )}
              </div>
            </div>
          </section>
        </aside>
      </div>
    </div>
  );
}
