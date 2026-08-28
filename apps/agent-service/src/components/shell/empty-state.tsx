import type { ReactNode } from "react";
import styles from "./shell.module.css";

function EmptyStateIllustration() {
  return (
    <div className={styles.emptyStateArt} aria-hidden="true">
      <div className={styles.emptyStateOrb} />
      <div className={styles.emptyStateCard}>
        <span className={styles.emptyStateAvatar} />
        <span className={styles.emptyStateLine} />
        <span className={`${styles.emptyStateLine} ${styles.emptyStateLineShort}`} />
        <span className={`${styles.emptyStateLine} ${styles.emptyStateLineMid}`} />
      </div>
      <svg
        className={styles.emptyStateSpark}
        width="36"
        height="36"
        viewBox="0 0 36 36"
        fill="none"
      >
        <path
          d="M18 3c.6 5.2 2.8 9.4 8 11-5.2 1.6-7.4 5.8-8 11-.6-5.2-2.8-9.4-8-11 5.2-1.6 7.4-5.8 8-11Z"
          fill="currentColor"
        />
        <path
          d="M28.5 20.5c.3 2.4 1.3 4.3 3.5 5-2.2.7-3.2 2.6-3.5 5-.3-2.4-1.3-4.3-3.5-5 2.2-.7 3.2-2.6 3.5-5Z"
          fill="currentColor"
          opacity="0.85"
        />
      </svg>
    </div>
  );
}

interface EmptyStateProps {
  title: string;
  description?: string;
  action?: ReactNode;
  /** Compact text-only empty (e.g. filter with no matches). */
  compact?: boolean;
}

export function EmptyState({
  title,
  description,
  action,
  compact = false,
}: EmptyStateProps) {
  if (compact) {
    return (
      <div className={styles.emptyStateCompact}>
        <p className={styles.emptyStateCompactTitle}>{title}</p>
        {description ? <p className={styles.emptyStateDescription}>{description}</p> : null}
      </div>
    );
  }

  return (
    <div className={styles.emptyState}>
      <EmptyStateIllustration />
      <h2 className={styles.emptyStateTitle}>{title}</h2>
      {description ? <p className={styles.emptyStateDescription}>{description}</p> : null}
      {action ? <div className={styles.emptyStateAction}>{action}</div> : null}
    </div>
  );
}
