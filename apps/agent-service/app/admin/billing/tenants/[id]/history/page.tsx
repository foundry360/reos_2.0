import Link from "next/link";
import { notFound } from "next/navigation";
import { BillingTenantHistoryContent } from "../../../../_components/billing-tenant-history-content";
import { BillingTenantSelect } from "../../../../_components/billing-tenant-select";
import {
  fetchBillingRollup,
  fetchTenantBillingHistory,
} from "@/lib/admin/billing-stats";
import { PageHeading } from "@/components/shell/page-heading";
import { IconCreditCard } from "@/components/shell/sidebar-nav";
import styles from "@/components/shell/shell.module.css";

interface PageProps {
  params: Promise<{ id: string }>;
}

export default async function AdminTenantBillingHistoryPage({ params }: PageProps) {
  const { id } = await params;
  const [history, rollup] = await Promise.all([
    fetchTenantBillingHistory(id),
    fetchBillingRollup(),
  ]);

  if (!history) notFound();

  return (
    <>
      <div className={styles.pageHeader}>
        <PageHeading
          icon={<IconCreditCard />}
          title="Previous Months Billing"
          subtitle={history.tenant.name}
          tone="light"
        />
        <div className={styles.pageHeaderActions}>
          <BillingTenantSelect
            tenantOptions={rollup.tenantOptions}
            selectedTenantId={id}
            tenantPathSuffix="history"
          />
          <Link
            href={history.currentHref}
            className={`${styles.btnSecondary} ${styles.btnPill}`}
          >
            Current Month
          </Link>
          <Link
            href={history.accountHref}
            className={`${styles.btnSecondary} ${styles.btnPill}`}
          >
            Open Account
          </Link>
        </div>
      </div>

      <BillingTenantHistoryContent history={history} />
    </>
  );
}
