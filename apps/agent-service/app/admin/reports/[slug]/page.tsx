import Link from "next/link";
import { notFound } from "next/navigation";
import { getCannedReport } from "@/lib/admin/report-catalog";
import styles from "@/components/shell/shell.module.css";

interface PageProps {
  params: Promise<{ slug: string }>;
}

export default async function AdminReportDetailPage({ params }: PageProps) {
  const { slug } = await params;
  const report = getCannedReport(slug);

  if (!report) notFound();

  return (
    <>
      <div className={styles.pageHeader}>
        <div>
          <h1 className={styles.pageTitle}>{report.title}</h1>
          <p className={styles.pageSubtitle}>{report.description}</p>
        </div>
        <div className={styles.pageHeaderActions}>
          <Link href="/admin/reports" className={`${styles.btnSecondary} ${styles.btnPill}`}>
            All reports
          </Link>
        </div>
      </div>

      <section className={styles.reportPlaceholder}>
        <p className={styles.reportPlaceholderEyebrow}>{report.category} report</p>
        <h2 className={styles.reportPlaceholderTitle}>Report view coming soon</h2>
        <p className={styles.reportPlaceholderBody}>
          This canned report is registered and ready for data wiring. Export, filters, and
          date ranges will be added in a follow-up.
        </p>
      </section>
    </>
  );
}
