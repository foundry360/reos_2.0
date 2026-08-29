import Link from "next/link";
import { AccountStatusBadge } from "@/lib/admin/account-status";
import { DashCardHeader } from "../dashboard/_components/dash-card-header";
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
} from "@/lib/admin/billing-stats";
import styles from "@/components/shell/shell.module.css";
import { BillingCategoryBreakdown } from "./billing-category-breakdown";

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
        <section className={`${styles.dashCard} ${styles.dashCardWithHeader}`}>
          <DashCardHeader
            title="Usage Breakdown"
            iconBadgeClassName={styles.dashCardIconFunnel}
            icon={<IconBillingChart />}
            action={
              <Link href={stats.accountHref} className={styles.dashCardLink}>
                Open Account
              </Link>
            }
          />
          <div className={styles.dashCardBody}>
            <p className={styles.dashCardSubtitle}>Twilio, AI, and other costs</p>
            <BillingCategoryBreakdown items={stats.categoryTotals} />
            {stats.totalUsageCents === 0 && (
              <p className={styles.billingEmptyHint}>
                Usage events will appear here once SMS and AI metering is enabled.
              </p>
            )}
          </div>
        </section>

        <section className={`${styles.dashCard} ${styles.dashCardWithHeader}`}>
          <DashCardHeader
            title="Account Status"
            iconBadgeClassName={styles.dashCardIconHealth}
            icon={<IconBillingStatus />}
          />
          <div className={styles.dashCardBody}>
            <p className={styles.dashCardSubtitle}>Billing readiness</p>
            <div className={styles.billingMetaList}>
              <div className={styles.billingMetaRow}>
                <span className={styles.billingMetaLabel}>Status</span>
                <AccountStatusBadge status={stats.tenant.status} />
              </div>
              <div className={styles.billingMetaRow}>
                <span className={styles.billingMetaLabel}>Billing customer</span>
                <strong>{stats.tenant.stripeCustomerId ?? "—"}</strong>
              </div>
              <div className={styles.billingMetaRow}>
                <span className={styles.billingMetaLabel}>Billing cycle</span>
                <strong>{stats.cycle.label}</strong>
              </div>
            </div>
          </div>
        </section>
      </div>
    </>
  );
}
