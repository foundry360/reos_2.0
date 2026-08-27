import { BillingRollupContent } from "../_components/billing-rollup-content";
import { BillingTenantSelect } from "../_components/billing-tenant-select";
import { fetchBillingRollup } from "@/lib/admin/billing-stats";
import styles from "@/components/shell/shell.module.css";

interface PageProps {
  searchParams: Promise<{ attention?: string }>;
}

export default async function AdminBillingPage({ searchParams }: PageProps) {
  const query = await searchParams;
  const stats = await fetchBillingRollup();
  const showMissingOnly = query.attention === "missing";

  return (
    <>
      <div className={styles.pageHeader}>
        <div>
          <h1 className={styles.pageTitle}>Billing</h1>
          <p className={styles.pageSubtitle}>
            Usage wallet rollup and billing readiness across tenants
          </p>
        </div>
        <div className={styles.pageHeaderActions}>
          <BillingTenantSelect tenantOptions={stats.tenantOptions} />
        </div>
      </div>

      {showMissingOnly ? (
        <p className={styles.billingFilterBanner}>
          Showing accounts that still need billing setup.
        </p>
      ) : null}

      <BillingRollupContent stats={stats} filterMissing={showMissingOnly} />
    </>
  );
}
