import Link from "next/link";
import type { CannedReport, ReportIconTone } from "@/lib/admin/report-catalog";
import styles from "@/components/shell/shell.module.css";

const TONE_CLASS: Record<ReportIconTone, string> = {
  blue: styles.dashStatIconBlue,
  green: styles.dashStatIconGreen,
  purple: styles.billingStatIconPurple,
  amber: styles.billingStatIconAmber,
};

function ReportIcon({ tone }: { tone: ReportIconTone }) {
  return (
    <span className={`${styles.dashStatIcon} ${TONE_CLASS[tone]}`} aria-hidden="true">
      <svg width="22" height="22" viewBox="0 0 24 24" fill="none">
        <path
          d="M4 19V5M4 19h16"
          stroke="currentColor"
          strokeWidth="1.75"
          strokeLinecap="round"
        />
        <path
          d="M8 16V11M12 16V8M16 16v-4"
          stroke="currentColor"
          strokeWidth="1.75"
          strokeLinecap="round"
        />
      </svg>
    </span>
  );
}

export function ReportCard({ report }: { report: CannedReport }) {
  return (
    <Link href={`/admin/reports/${report.slug}`} className={styles.reportCard}>
      <div className={styles.reportCardTop}>
        <ReportIcon tone={report.iconTone} />
        <span className={styles.reportCardCategory}>{report.category}</span>
      </div>
      <h2 className={styles.reportCardTitle}>{report.title}</h2>
      <p className={styles.reportCardDesc}>{report.description}</p>
      <span className={styles.reportCardAction}>Open report →</span>
    </Link>
  );
}
