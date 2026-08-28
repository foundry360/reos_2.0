import { ReportCard } from "../_components/report-card";
import { CANNED_REPORTS } from "@/lib/admin/report-catalog";
import { PageHeading } from "@/components/shell/page-heading";
import { IconReports } from "@/components/shell/sidebar-nav";
import styles from "@/components/shell/shell.module.css";

export default function AdminReportsPage() {
  return (
    <>
      <div className={styles.pageHeader}>
        <PageHeading
          icon={<IconReports />}
          title="Reporting"
          subtitle="Canned reports across usage, accounts, billing, and operations"
          tone="accent"
        />
      </div>

      <div className={styles.reportsGrid}>
        {CANNED_REPORTS.map((report) => (
          <ReportCard key={report.slug} report={report} />
        ))}
      </div>
    </>
  );
}
