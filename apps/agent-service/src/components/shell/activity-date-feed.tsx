"use client";

import Link from "next/link";
import { useEffect, useState, useTransition, type FormEvent, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import type { PersonActivityItem } from "@/lib/crm/person-activities";
import { groupByActivityDate } from "@/lib/crm/activity-date-groups";
import { updateActivityAction } from "@/lib/crm/crm-actions";
import { EditFormActions } from "@/components/shell/inline-edit";
import styles from "./shell.module.css";

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

export function DateGroupAccordion({
  groupKey,
  label,
  children,
}: {
  groupKey: string;
  label: string;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(true);

  return (
    <section
      className={`${styles.dealActivityGroup}${
        open ? "" : ` ${styles.dealActivityGroupCollapsed}`
      }`}
    >
      <button
        type="button"
        className={styles.dealActivityGroupTrigger}
        aria-expanded={open}
        aria-controls={`activity-date-group-${groupKey}`}
        onClick={() => setOpen((value) => !value)}
      >
        <span className={styles.dealActivityGroupHeading}>{label}</span>
        <AccordionChevron open={open} />
      </button>
      {open ? (
        <div id={`activity-date-group-${groupKey}`} className={styles.dealActivityGroupPanel}>
          {children}
        </div>
      ) : null}
    </section>
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

function IconHandshake() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path
        d="m11 17 2 2a1 1 0 1 0 3-3"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="m14 14 2.5 2.5a1 1 0 1 0 3-3l-3.88-3.88a3 3 0 0 0-4.24 0l-.88.88a1 1 0 1 1-3-3l2.81-2.81a5.79 5.79 0 0 1 7.06-.87l.47.28a2 2 0 0 0 1.42.25L21 4"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="m21 3 1 11h-2"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M3 3 2 14l6.5 6.5a1 1 0 1 0 3-3"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M3 4h8"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
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

function IconEmail() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <rect x="3" y="5" width="18" height="14" rx="2" stroke="currentColor" strokeWidth="2" />
      <path d="M3 7l9 7 9-7" stroke="currentColor" strokeWidth="2" strokeLinejoin="round" />
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

function IconPerson() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <circle cx="12" cy="8" r="4" stroke="currentColor" strokeWidth="2" />
      <path
        d="M4 20c1.5-3.5 4.5-5 8-5s6.5 1.5 8 5"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
      />
    </svg>
  );
}

function IconLead() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path
        d="M16 21v-2a4 4 0 00-4-4H6a4 4 0 00-4 4v2"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <circle cx="9" cy="7" r="4" stroke="currentColor" strokeWidth="2" />
      <path d="M19 8v6M22 11h-6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    </svg>
  );
}

function IconPage() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path
        d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinejoin="round"
      />
      <path d="M14 2v6h6M8 13h8M8 17h5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
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

const ACTIVITY_ICON_META: Record<
  string,
  { color: string; icon: ReactNode; darkIcon?: boolean }
> = {
  note: { color: "#55A9DB", icon: <IconNote /> },
  task: { color: "#f6d73c", icon: <IconTask />, darkIcon: true },
  opportunity: { color: "#16b29b", icon: <IconHandshake /> },
  call: { color: "#fa8f59", icon: <IconCall /> },
  email: { color: "#16b29b", icon: <IconEmail /> },
  meeting: { color: "#55A9DB", icon: <IconMeeting /> },
  contact: { color: "#55A9DB", icon: <IconPerson /> },
  lead: { color: "#55A9DB", icon: <IconLead /> },
  page: { color: "#94a3b8", icon: <IconPage /> },
  other: { color: "#94a3b8", icon: <IconActivities /> },
};

export function ActivityTypeIcon({ type }: { type: string }) {
  const meta = ACTIVITY_ICON_META[type] ?? ACTIVITY_ICON_META.other;
  return (
    <span
      className={`${styles.dealActivityAvatar}${
        meta.darkIcon ? ` ${styles.dealActivityAvatarDarkIcon}` : ""
      }`}
      style={{ backgroundColor: meta.color }}
      aria-hidden
    >
      {meta.icon}
    </span>
  );
}

function IconCalendar() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <rect x="3" y="5" width="18" height="16" rx="2" stroke="currentColor" strokeWidth="2" />
      <path d="M8 3v4M16 3v4M3 10h18" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    </svg>
  );
}

function ActivityTimestamp({
  activity,
  formatTime,
  timeTitle,
}: {
  activity: PersonActivityItem;
  formatTime: (iso: string) => string;
  timeTitle?: (iso: string) => string;
}) {
  const formatted = formatTime(activity.occurredAt);
  return (
    <time
      className={`${styles.dealActivityTime}${
        activity.timeKind === "due" ? ` ${styles.dealActivityTimeDue}` : ""
      }`}
      dateTime={activity.occurredAt}
      title={timeTitle?.(activity.occurredAt)}
    >
      {activity.timeKind === "due" ? (
        <>
          <IconCalendar />
          <span>Due: {formatted}</span>
        </>
      ) : (
        formatted
      )}
    </time>
  );
}

function noteEditableTitle(displayTitle: string): string {
  return displayTitle.replace(/^Note created:\s*/i, "").trim();
}

function activityRecordId(activityId: string): string {
  return activityId.replace(/^activity:/, "");
}

function NoteActivityCard({
  activity,
  formatTime,
  timeTitle,
}: {
  activity: PersonActivityItem;
  formatTime: (iso: string) => string;
  timeTitle?: (iso: string) => string;
}) {
  const router = useRouter();
  const [expanded, setExpanded] = useState(false);
  const [title, setTitle] = useState(() => noteEditableTitle(activity.title));
  const [body, setBody] = useState(() => activity.body ?? "");
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  useEffect(() => {
    if (expanded) return;
    setTitle(noteEditableTitle(activity.title));
    setBody(activity.body ?? "");
  }, [activity.title, activity.body, expanded]);

  function handleCancel() {
    setTitle(noteEditableTitle(activity.title));
    setBody(activity.body ?? "");
    setError(null);
    setExpanded(false);
  }

  function handleSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
    const formData = new FormData();
    formData.set("activityId", activityRecordId(activity.id));
    formData.set("title", title.trim());
    formData.set("body", body.trim());

    startTransition(async () => {
      const result = await updateActivityAction(formData);
      if (!result.ok) {
        setError(result.error ?? "Could not save note.");
        return;
      }
      setExpanded(false);
      router.refresh();
    });
  }

  if (expanded) {
    return (
      <form
        className={`${styles.dealActivityItem} ${styles.dealActivityNoteEdit}`}
        onSubmit={handleSubmit}
      >
        <div className={styles.dealActivityNoteEditHeader}>
          <ActivityTypeIcon type={activity.type} />
          <span className={styles.dealActivityNoteEditLabel}>Edit Note</span>
          <time
            className={styles.dealActivityTime}
            dateTime={activity.occurredAt}
            title={timeTitle?.(activity.occurredAt)}
          >
            {formatTime(activity.occurredAt)}
          </time>
        </div>

        {error ? <p className={styles.error}>{error}</p> : null}

        <div className={styles.field}>
          <label className={styles.label} htmlFor={`note-title-${activity.id}`}>
            Title
          </label>
          <input
            id={`note-title-${activity.id}`}
            className={styles.input}
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            required
            disabled={pending}
          />
        </div>

        <div className={styles.field}>
          <label className={styles.label} htmlFor={`note-body-${activity.id}`}>
            Note
          </label>
          <textarea
            id={`note-body-${activity.id}`}
            className={styles.input}
            rows={4}
            value={body}
            onChange={(e) => setBody(e.target.value)}
            disabled={pending}
          />
        </div>

        <EditFormActions pending={pending} onCancel={handleCancel} saveLabel="Save Note" />
      </form>
    );
  }

  return (
    <button
      type="button"
      className={`${styles.dealActivityItem} ${styles.dealActivityNoteTrigger}`}
      onClick={() => setExpanded(true)}
      aria-expanded={false}
    >
      <ActivityTypeIcon type={activity.type} />
      <span className={styles.dealActivityMain}>
        <span className={styles.dealActivityTitle}>{activity.title}</span>
        {activity.body ? (
          <span className={styles.dealActivityMeta}>{activity.body}</span>
        ) : (
          <span className={styles.dealActivityMeta}>{activity.typeLabel}</span>
        )}
      </span>
      <ActivityTimestamp activity={activity} formatTime={formatTime} timeTitle={timeTitle} />
      <span className={styles.dealActivityNoteChevron} aria-hidden>
        <AccordionChevron open={false} />
      </span>
    </button>
  );
}

interface ActivityDateFeedProps {
  activities: PersonActivityItem[];
  formatTime: (iso: string) => string;
  timeTitle?: (iso: string) => string;
}

/** Date-grouped accordion feed with timeline tree (Today, Yesterday, …). */
export function ActivityDateFeed({
  activities,
  formatTime,
  timeTitle,
}: ActivityDateFeedProps) {
  const groups = groupByActivityDate(activities, (item) => item.occurredAt);

  return (
    <div className={styles.dealActivityFeed}>
      {groups.map((group) => (
        <DateGroupAccordion
          key={group.key}
          groupKey={group.key}
          label={group.label}
        >
          <ul className={styles.dealActivityList}>
            {group.items.map((activity) => {
              if (activity.source === "activity" && activity.type === "note") {
                return (
                  <li key={activity.id} className={styles.dealActivityTreeItem}>
                    <NoteActivityCard
                      activity={activity}
                      formatTime={formatTime}
                      timeTitle={timeTitle}
                    />
                  </li>
                );
              }

              const content = (
                <>
                  <ActivityTypeIcon type={activity.type} />
                  <span className={styles.dealActivityMain}>
                    <span className={styles.dealActivityTitle}>{activity.title}</span>
                    {activity.body ? (
                      <span className={styles.dealActivityMeta}>{activity.body}</span>
                    ) : (
                      <span className={styles.dealActivityMeta}>{activity.typeLabel}</span>
                    )}
                  </span>
                  <ActivityTimestamp
                    activity={activity}
                    formatTime={formatTime}
                    timeTitle={timeTitle}
                  />
                </>
              );

              return (
                <li key={activity.id} className={styles.dealActivityTreeItem}>
                  {activity.href ? (
                    <Link href={activity.href} className={styles.dealActivityItem}>
                      {content}
                    </Link>
                  ) : (
                    <div className={styles.dealActivityItem}>{content}</div>
                  )}
                </li>
              );
            })}
          </ul>
        </DateGroupAccordion>
      ))}
    </div>
  );
}
