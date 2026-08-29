import Link from "next/link";
import { AccountStatusBadge } from "@/lib/admin/account-status";
import { BillingTopSpenderCard } from "./billing-top-spender-card";
import {
  BillingStatCard,
  IconBillingCard,
  IconBillingTenants,
  IconBillingWallet,
  IconBillingChart,
  IconBillingAlert,
} from "./billing-stat-card";
import {
  formatUsdFromCents,
  type BillingRollupStats,
} from "@/lib/admin/billing-stats";
import styles from "@/components/shell/shell.module.css";
import { BillingCategoryBreakdown } from "./billing-category-breakdown";
import { BillingTenantsTable } from "./billing-tenants-table";
import type { AdminLayout } from "./admin-layout-toggle";

export function BillingRollupContent({
  stats,
  filterMissing = false,
  layout = "list",
}: {
  stats: BillingRollupStats;
  filterMissing?: boolean;
  layout?: AdminLayout;
}) {
  const topSpender = stats.tenants.find((tenant) => tenant.cycleUsageCents > 0) ?? null;

  return (
    <>
      <div className={styles.billingStatGrid}>
        <BillingStatCard label="Cycle usage" icon={<IconBillingWallet />} iconTone="blue">
          <p className={styles.billingStatValue}>{formatUsdFromCents(stats.totalUsageCents)}</p>
          <p className={styles.dashStatHint}>{stats.cycle.label}</p>
        </BillingStatCard>

        <BillingStatCard
          label="Tenants with usage"
          icon={<IconBillingTenants />}
          iconTone="green"
        >
          <p className={styles.billingStatValue}>{stats.tenantsWithUsage}</p>
          <p className={styles.dashStatHint}>{stats.activeTenantCount} active accounts</p>
        </BillingStatCard>

        <BillingStatCard
          label="Billing configured"
          icon={<IconBillingCard />}
          iconTone="amber"
        >
          <p className={styles.billingStatValue}>{stats.configuredBillingCount}</p>
          <p className={styles.dashStatHint}>
            {stats.missingBillingCount} missing billing customer
          </p>
        </BillingStatCard>

        <BillingTopSpenderCard
          topSpender={
            topSpender
              ? {
                  name: topSpender.name,
                  cycleUsageCents: topSpender.cycleUsageCents,
                  href: topSpender.href,
                }
              : null
          }
        />
      </div>

      <div className={styles.billingGridSecondary}>
        <section className={styles.dashCard}>
          <div className={styles.dashCardHeader}>
            <div className={styles.billingSectionHeaderMain}>
              <span className={`${styles.dashStatIcon} ${styles.dashStatIconBlue}`} aria-hidden="true">
                <IconBillingChart />
              </span>
              <div>
                <h2 className={styles.dashCardTitle}>Usage by category</h2>
                <p className={styles.dashCardSubtitle}>Platform rollup for {stats.cycle.label}</p>
              </div>
            </div>
          </div>
          <BillingCategoryBreakdown items={stats.categoryTotals} />
        </section>

        <section className={styles.dashCard}>
          <div className={styles.dashCardHeader}>
            <div className={styles.billingSectionHeaderMain}>
              <span className={`${styles.dashStatIcon} ${styles.billingStatIconAmber}`} aria-hidden="true">
                <IconBillingAlert />
              </span>
              <div>
                <h2 className={styles.dashCardTitle}>Attention</h2>
                <p className={styles.dashCardSubtitle}>Accounts that need billing setup</p>
              </div>
            </div>
            {stats.missingBillingCount > 0 && (
              <Link href="/admin/billing?attention=missing" className={styles.dashCardLink}>
                View All
              </Link>
            )}
          </div>
          {stats.missingBillingCount === 0 ? (
            <p className={styles.empty}>All active and testing accounts have billing configured.</p>
          ) : (
            <ul className={styles.billingAttentionList}>
              {stats.tenants
                .filter(
                  (tenant) =>
                    !tenant.stripeCustomerId &&
                    (tenant.status === "active" || tenant.status === "testing"),
                )
                .slice(0, 6)
                .map((tenant) => (
                  <li key={tenant.id}>
                    <Link href={tenant.href} className={styles.billingAttentionItem}>
                      <span className={styles.billingAttentionMain}>
                        <strong>{tenant.name}</strong>
                        <small>{tenant.slug}</small>
                      </span>
                      <AccountStatusBadge status={tenant.status} />
                    </Link>
                  </li>
                ))}
            </ul>
          )}
        </section>
      </div>

      <BillingTenantsTable tenants={stats.tenants} filterMissing={filterMissing} layout={layout} />
    </>
  );
}
