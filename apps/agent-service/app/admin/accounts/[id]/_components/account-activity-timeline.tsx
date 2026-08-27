import {
  buildActivityTimeline,
  formatRelativeTime,
  type ActivityTimelineIcon,
  type ActivityTimelineTone,
} from "@/lib/admin/activity-timeline";
import type { TenantConfig } from "@/lib/admin/tenant-config";
import styles from "@/components/shell/shell.module.css";

interface AccountActivityTimelineProps {
  tenant: TenantConfig;
  userCount: number;
}

const TONE_CLASS: Record<ActivityTimelineTone, string> = {
  purple: styles.activityTimelineDotPurple,
  green: styles.activityTimelineDotGreen,
  cyan: styles.activityTimelineDotCyan,
  blue: styles.activityTimelineDotBlue,
};

function TimelineIcon({ icon }: { icon: ActivityTimelineIcon }) {
  switch (icon) {
    case "created":
      return (
        <svg viewBox="0 0 16 16" fill="none" aria-hidden="true">
          <path
            d="M8 3.5v9M3.5 8h9"
            stroke="currentColor"
            strokeWidth="1.75"
            strokeLinecap="round"
          />
        </svg>
      );
    case "updated":
      return (
        <svg viewBox="0 0 16 16" fill="none" aria-hidden="true">
          <path
            d="M3.5 12.5l1.2-4.2L11.8 1.7a1.2 1.2 0 011.7 1.7L6.7 11.3l-3.2 1.2z"
            stroke="currentColor"
            strokeWidth="1.4"
            strokeLinejoin="round"
          />
        </svg>
      );
    case "activated":
      return (
        <svg viewBox="0 0 16 16" fill="none" aria-hidden="true">
          <path
            d="M3.5 8.25l3 3 6-6.5"
            stroke="currentColor"
            strokeWidth="1.75"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      );
    case "phone":
      return (
        <svg viewBox="0 0 16 16" fill="none" aria-hidden="true">
          <path
            d="M5.2 2.8l1.6 1.6c.2.2.2.5 0 .7l-.9.9a8.5 8.5 0 004.1 4.1l.9-.9c.2-.2.5-.2.7 0l1.6 1.6c.2.2.2.5 0 .7l-.8.8a2 2 0 01-1.5.6C6.8 13 3 9.2 3 4.8c0-.6.2-1.1.6-1.5l.8-.8c.2-.2.5-.2.8 0z"
            stroke="currentColor"
            strokeWidth="1.3"
            strokeLinejoin="round"
          />
        </svg>
      );
    case "stripe":
      return (
        <svg viewBox="0 0 16 16" fill="none" aria-hidden="true">
          <rect
            x="2.5"
            y="4"
            width="11"
            height="8"
            rx="1.5"
            stroke="currentColor"
            strokeWidth="1.4"
          />
          <path d="M2.5 6.5h11" stroke="currentColor" strokeWidth="1.4" />
        </svg>
      );
    case "channel":
      return (
        <svg viewBox="0 0 16 16" fill="none" aria-hidden="true">
          <path
            d="M6.5 9.5l3-3M7 4.5H5.2A2.2 2.2 0 003 6.7v3.6A2.2 2.2 0 005.2 12.5H8.8A2.2 2.2 0 0011 10.3V8.5"
            stroke="currentColor"
            strokeWidth="1.4"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
          <path
            d="M9 3.5h3.5V7"
            stroke="currentColor"
            strokeWidth="1.4"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      );
    case "users":
      return (
        <svg viewBox="0 0 16 16" fill="none" aria-hidden="true">
          <circle cx="6" cy="5.5" r="2" stroke="currentColor" strokeWidth="1.4" />
          <path
            d="M2.5 12.5c0-1.9 1.6-3.4 3.5-3.4s3.5 1.5 3.5 3.4"
            stroke="currentColor"
            strokeWidth="1.4"
            strokeLinecap="round"
          />
          <circle cx="11" cy="6" r="1.5" stroke="currentColor" strokeWidth="1.3" />
          <path
            d="M12.5 12.5c0-1.4-.8-2.5-2-3"
            stroke="currentColor"
            strokeWidth="1.3"
            strokeLinecap="round"
          />
        </svg>
      );
  }
}

export function AccountActivityTimeline({
  tenant,
  userCount,
}: AccountActivityTimelineProps) {
  const entries = buildActivityTimeline(tenant, userCount);

  return (
    <div className={styles.accountDetailCard}>
      <div className={styles.sidebarCardHeader}>
        <h2 className={styles.sidebarCardTitle}>Activity Timeline</h2>
      </div>

      <div className={styles.activityTimelineBody}>
        {entries.length === 0 ? (
          <p className={styles.activityTimelineEmpty}>No activity yet.</p>
        ) : (
          <ol className={styles.activityTimelineList}>
            {entries.map((entry) => (
              <li key={entry.id} className={styles.activityTimelineItem}>
                <span
                  className={`${styles.activityTimelineDot} ${TONE_CLASS[entry.tone]}`}
                  aria-hidden="true"
                >
                  <TimelineIcon icon={entry.icon} />
                </span>
                <div className={styles.activityTimelineContent}>
                  <div className={styles.activityTimelineHeading}>
                    <h3 className={styles.activityTimelineTitle}>{entry.title}</h3>
                    <time
                      className={styles.activityTimelineTime}
                      dateTime={entry.occurredAt}
                    >
                      {formatRelativeTime(entry.occurredAt)}
                    </time>
                  </div>
                  {entry.description && (
                    <p className={styles.activityTimelineDesc}>{entry.description}</p>
                  )}
                </div>
              </li>
            ))}
          </ol>
        )}
      </div>
    </div>
  );
}
