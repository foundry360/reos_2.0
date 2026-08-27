import Link from "next/link";
import { AccountStatusBadge } from "@/lib/admin/account-status";
import { BillingTopSpenderCard } from "./billing-top-spender-card";
import {
  BillingStatCard,
  IconBillingAccount,
  IconBillingCard,
  IconBillingWallet,
  IconBillingChart,
  IconBillingStatus,
} from "./billing-stat-card";
import {
  formatUsdFromCents,
  type TenantBillingStats,
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

export function BillingTenantContent({ stats }: { stats: TenantBillingStats }) {
  return (
    <>
      <div className={styles.billingStatGrid}>
        <BillingStatCard label="Usage wallet" icon={<IconBillingWallet />} iconTone="blue">
          <p className={styles.billingStatValue}>{formatUsdFromCents(stats.totalUsageCents)}</p>
          <p className={styles.dashStatHint}>{stats.cycle.label}</p>
        </BillingStatCard>

        <BillingStatCard label="Account" icon={<IconBillingAccount />} iconTone="green">
          <p className={styles.billingStatName}>{stats.tenant.name}</p>
          <p className={styles.dashStatHint}>{stats.tenant.slug}</p>
        </BillingStatCard>

        <BillingStatCard label="Billing" icon={<IconBillingCard />} iconTone="amber">
          <p
            className={`${styles.billingStatStatus} ${
              stats.tenant.stripeCustomerId ? "" : styles.billingStatStatusMuted
            }`}
          >
            {stats.tenant.stripeCustomerId ? "Connected" : "Not configured"}
          </p>
          <p className={styles.dashStatHint}>
            {stats.tenant.stripeCustomerId ?? "No billing customer ID on file"}
          </p>
        </BillingStatCard>

        <BillingTopSpenderCard scopedToTenant />
      </div>

      <div className={styles.billingGridSecondary}>
        <section className={styles.dashCard}>
          <div className={styles.dashCardHeader}>
            <div className={styles.billingSectionHeaderMain}>
              <span className={`${styles.dashStatIcon} ${styles.dashStatIconBlue}`} aria-hidden="true">
                <IconBillingChart />
              </span>
              <div>
                <h2 className={styles.dashCardTitle}>Usage breakdown</h2>
                <p className={styles.dashCardSubtitle}>Twilio, AI, and other costs</p>
              </div>
            </div>
            <Link href={stats.accountHref} className={styles.dashCardLink}>
              Open account
            </Link>
          </div>
          <CategoryBreakdown items={stats.categoryTotals} />
          {stats.totalUsageCents === 0 && (
            <p className={styles.billingEmptyHint}>
              Usage events will appear here once SMS and AI metering is enabled.
            </p>
          )}
        </section>

        <section className={styles.dashCard}>
          <div className={styles.dashCardHeader}>
            <div className={styles.billingSectionHeaderMain}>
              <span className={`${styles.dashStatIcon} ${styles.dashStatIconGreen}`} aria-hidden="true">
                <IconBillingStatus />
              </span>
              <div>
                <h2 className={styles.dashCardTitle}>Account status</h2>
                <p className={styles.dashCardSubtitle}>Billing readiness</p>
              </div>
            </div>
          </div>
          <div className={styles.billingMetaList}>
            <div className={styles.billingMetaRow}>
              <span>Status</span>
              <AccountStatusBadge status={stats.tenant.status} />
            </div>
            <div className={styles.billingMetaRow}>
              <span>Billing customer</span>
              <strong>{stats.tenant.stripeCustomerId ?? "—"}</strong>
            </div>
            <div className={styles.billingMetaRow}>
              <span>Billing cycle</span>
              <strong>{stats.cycle.label}</strong>
            </div>
          </div>
        </section>
      </div>
    </>
  );
}
