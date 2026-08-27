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
  type UsageCategoryTotal,
} from "@/lib/admin/billing-stats";
import styles from "@/components/shell/shell.module.css";

function CategoryBreakdown({ items }: { items: UsageCategoryTotal[] }) {
  const max = Math.max(1, ...items.map((item) => item.amountCents));

  return (
    <div className={styles.billingCategoryList}>
      {items.map((item) => (
        <div key={item.category} className={styles.billingCategoryRow}>
          <span className={styles.billingCategoryLabel}>{item.label}</span>
          <span className={styles.billingCategoryTrack}>
            <span
              className={styles.billingCategoryFill}
              style={{
                width: `${item.amountCents === 0 ? 0 : Math.max(8, (item.amountCents / max) * 100)}%`,
              }}
            />
          </span>
          <span className={styles.billingCategoryValue}>
            {formatUsdFromCents(item.amountCents)}
          </span>
        </div>
      ))}
    </div>
  );
}

export function BillingRollupContent({
  stats,
  filterMissing = false,
}: {
  stats: BillingRollupStats;
  filterMissing?: boolean;
}) {
  const visibleTenants = filterMissing
    ? stats.tenants.filter(
        (tenant) =>
          !tenant.stripeCustomerId &&
          (tenant.status === "active" || tenant.status === "testing"),
      )
    : stats.tenants;

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
          <CategoryBreakdown items={stats.categoryTotals} />
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
                View all
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

      <section className={styles.tableWrap}>
        <div className={styles.billingTableHeader}>
          <div>
            <h2 className={styles.dashCardTitle}>Tenant usage</h2>
            <p className={styles.dashCardSubtitle}>Current cycle by account</p>
          </div>
        </div>
        {visibleTenants.length === 0 ? (
          <p className={styles.empty}>
            {filterMissing
              ? "All active and testing accounts have billing configured."
              : "No accounts yet."}
          </p>
        ) : (
          <table className={styles.table}>
            <thead>
              <tr>
                <th>Account</th>
                <th>Status</th>
                <th>Billing</th>
                <th>Cycle usage</th>
              </tr>
            </thead>
            <tbody>
              {visibleTenants.map((tenant) => (
                <tr key={tenant.id}>
                  <td>
                    <Link href={tenant.href} className={styles.tableCellLink}>
                      {tenant.name}
                    </Link>
                    <div className={styles.billingTableSubtext}>{tenant.slug}</div>
                  </td>
                  <td>
                    <AccountStatusBadge status={tenant.status} />
                  </td>
                  <td>{tenant.stripeCustomerId ? "Connected" : "Not configured"}</td>
                  <td className={styles.billingAmountCell}>
                    {formatUsdFromCents(tenant.cycleUsageCents)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </>
  );
}
