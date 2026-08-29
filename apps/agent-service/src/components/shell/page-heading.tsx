import type { ReactNode } from "react";
import styles from "./shell.module.css";

/** Platform blue-gray tones only. */
export type PageHeadingTone =
  | "accent"
  | "brand"
  | "light"
  | "dark"
  | "person"
  | "opportunity"
  | "task";

const TONE_CLASS: Record<PageHeadingTone, string | undefined> = {
  accent: undefined,
  brand: styles.pageTitleIconBrand,
  light: styles.pageTitleIconLight,
  dark: styles.pageTitleIconDark,
  person: styles.pageTitleIconPerson,
  opportunity: styles.pageTitleIconOpportunity,
  task: styles.pageTitleIconTask,
};

interface PageHeadingProps {
  icon: ReactNode;
  title: ReactNode;
  subtitle?: ReactNode;
  /** Optional line above the title (e.g. back link). */
  eyebrow?: ReactNode;
  /** Blue-gray background behind the white round icon. */
  tone?: PageHeadingTone;
}

export function PageHeading({
  icon,
  title,
  subtitle,
  eyebrow,
  tone = "accent",
}: PageHeadingProps) {
  const toneClass = TONE_CLASS[tone];

  return (
    <div>
      {eyebrow ? <p className={styles.pageSubtitle}>{eyebrow}</p> : null}
      <div className={styles.pageTitleRow}>
        <span
          className={`${styles.pageTitleIcon}${toneClass ? ` ${toneClass}` : ""}`}
          aria-hidden
        >
          {icon}
        </span>
        <h1 className={styles.pageTitle}>{title}</h1>
      </div>
      {subtitle ? <p className={styles.pageSubtitle}>{subtitle}</p> : null}
    </div>
  );
}
