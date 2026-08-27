import { ReportCard } from "../_components/report-card";
import { CANNED_REPORTS } from "@/lib/admin/report-catalog";
import styles from "@/components/shell/shell.module.css";

export default function AdminReportsPage() {
  return (
    <>
      <div className={styles.pageHeader}>
        <div>
          <h1 className={styles.pageTitle}>Reporting</h1>
          <p className={styles.pageSubtitle}>
            Canned reports across usage, accounts, billing, and operations
          </p>
        </div>
      </div>

      <div className={styles.reportsGrid}>
        {CANNED_REPORTS.map((report) => (
          <ReportCard key={report.slug} report={report} />
        ))}
      </div>
    </>
  );
}
