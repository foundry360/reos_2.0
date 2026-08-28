import { BillingLayoutToggle } from "../_components/billing-layout-toggle";
import { BillingRollupContent } from "../_components/billing-rollup-content";
import { BillingTenantSelect } from "../_components/billing-tenant-select";
import { fetchBillingRollup } from "@/lib/admin/billing-stats";
import { PageHeading } from "@/components/shell/page-heading";
import { IconCreditCard } from "@/components/shell/sidebar-nav";
import styles from "@/components/shell/shell.module.css";

interface PageProps {
  searchParams: Promise<{ attention?: string; layout?: string }>;
}

export default async function AdminBillingPage({ searchParams }: PageProps) {
  const query = await searchParams;
  const stats = await fetchBillingRollup();
  const showMissingOnly = query.attention === "missing";
  const layout = query.layout === "kanban" ? "kanban" : "list";

  return (
    <div className={layout === "kanban" ? styles.kanbanPage : undefined}>
      <div className={styles.pageHeader}>
        <PageHeading
          icon={<IconCreditCard />}
          title="Billing"
          subtitle="Usage wallet rollup and billing readiness across tenants"
          tone="light"
        />
        <div className={styles.pageHeaderActions}>
          <BillingLayoutToggle layout={layout} attention={showMissingOnly} />
          <BillingTenantSelect tenantOptions={stats.tenantOptions} />
        </div>
      </div>

      {showMissingOnly ? (
        <p className={styles.billingFilterBanner}>
          Showing accounts that still need billing setup.
        </p>
      ) : null}

      <BillingRollupContent stats={stats} filterMissing={showMissingOnly} layout={layout} />
    </div>
  );
}
