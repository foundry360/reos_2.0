import Link from "next/link";
import { notFound } from "next/navigation";
import { BillingTenantContent } from "../../../_components/billing-tenant-content";
import { BillingTenantSelect } from "../../../_components/billing-tenant-select";
import { fetchBillingRollup, fetchTenantBillingStats } from "@/lib/admin/billing-stats";
import { PageHeading } from "@/components/shell/page-heading";
import { IconCreditCard } from "@/components/shell/sidebar-nav";
import styles from "@/components/shell/shell.module.css";

interface PageProps {
  params: Promise<{ id: string }>;
}

export default async function AdminTenantBillingPage({ params }: PageProps) {
  const { id } = await params;
  const [stats, rollup] = await Promise.all([
    fetchTenantBillingStats(id),
    fetchBillingRollup(),
  ]);

  if (!stats) notFound();

  return (
    <>
      <div className={styles.pageHeader}>
        <PageHeading
          icon={<IconCreditCard />}
          title="Billing"
          subtitle={stats.tenant.name}
          tone="light"
        />
        <div className={styles.pageHeaderActions}>
          <BillingTenantSelect tenantOptions={rollup.tenantOptions} selectedTenantId={id} />
          <Link href={stats.accountHref} className={`${styles.btnSecondary} ${styles.btnPill}`}>
            Open Account
          </Link>
        </div>
      </div>

      <BillingTenantContent stats={stats} />
    </>
  );
}
