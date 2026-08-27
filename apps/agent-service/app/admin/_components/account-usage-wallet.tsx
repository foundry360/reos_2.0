import Link from "next/link";
import { IconBillingWallet } from "./billing-stat-card";
import {
  formatUsdFromCents,
  type BillingCycleWindow,
  type UsageCategoryTotal,
} from "@/lib/admin/billing-stats";
import styles from "@/components/shell/shell.module.css";

interface AccountUsageWalletProps {
  tenantId: string;
  cycle: BillingCycleWindow;
  totalUsageCents: number;
  categoryTotals: UsageCategoryTotal[];
}

export function AccountUsageWallet({
  tenantId,
  cycle,
  totalUsageCents,
  categoryTotals,
}: AccountUsageWalletProps) {
  const activeCategories = categoryTotals.filter((item) => item.amountCents > 0);

  return (
    <section className={styles.billingWalletCard}>
      <div className={styles.sidebarCardHeader}>
        <div className={styles.sidebarCardHeaderMain}>
          <span className={`${styles.accordionIconBadge} ${styles.billingWalletIconBadge}`}>
            <IconBillingWallet />
          </span>
          <h2 className={styles.sidebarCardTitle}>Usage Wallet</h2>
        </div>
        <Link href={`/admin/billing/tenants/${tenantId}`} className={styles.dashCardLink}>
          View in Billing
        </Link>
      </div>

      <div className={styles.billingWalletBody}>
        <p className={styles.billingWalletTotal}>{formatUsdFromCents(totalUsageCents)}</p>
        <p className={styles.billingWalletCycle}>{cycle.label}</p>

        {activeCategories.length > 0 ? (
          <ul className={styles.billingWalletCategories}>
            {activeCategories.map((item) => (
              <li key={item.category}>
                <span className={styles.billingWalletCategoryLabel}>{item.label}</span>
                <span className={styles.billingWalletLeader} aria-hidden="true" />
                <strong className={styles.billingWalletCategoryAmount}>
                  {formatUsdFromCents(item.amountCents)}
                </strong>
              </li>
            ))}
          </ul>
        ) : (
          <p className={styles.billingEmptyHint}>
            No usage recorded this cycle yet. SMS and AI costs will roll up here.
          </p>
        )}
      </div>
    </section>
  );
}
