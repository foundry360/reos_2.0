import { displayValue } from "@/lib/display-value";
import styles from "./shell.module.css";

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

export function TablePhoneCell({
  value,
  empty = displayValue(null),
}: {
  value: string | null | undefined;
  empty?: string;
}) {
  const text = value?.trim();
  if (!text) return <>{empty}</>;

  return (
    <span className={styles.tableCellWithIcon}>
      <span className={styles.tableCellIcon}>
        <IconPhone />
      </span>
      <span className={styles.tableCellIconText}>{text}</span>
    </span>
  );
}

export function TableEmailCell({
  value,
  empty = displayValue(null),
}: {
  value: string | null | undefined;
  empty?: string;
}) {
  const text = value?.trim();
  if (!text) return <>{empty}</>;

  return (
    <span className={styles.tableCellWithIcon}>
      <span className={styles.tableCellIcon}>
        <IconMail />
      </span>
      <span className={styles.tableCellIconText}>{text}</span>
    </span>
  );
}
