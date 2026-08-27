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
      <div className={styles.billingWalletHeader}>
        <div className={styles.billingSectionHeaderMain}>
          <span className={`${styles.dashStatIcon} ${styles.dashStatIconBlue}`} aria-hidden="true">
            <IconBillingWallet />
          </span>
          <div>
            <h2 className={styles.sidebarCardTitle}>Usage wallet</h2>
            <p className={styles.billingWalletSubtitle}>{cycle.label}</p>
          </div>
        </div>
        <Link href={`/admin/billing/tenants/${tenantId}`} className={styles.dashCardLink}>
          View in Billing
        </Link>
      </div>

      <p className={styles.billingWalletTotal}>{formatUsdFromCents(totalUsageCents)}</p>

      {activeCategories.length > 0 ? (
        <ul className={styles.billingWalletCategories}>
          {activeCategories.map((item) => (
            <li key={item.category}>
              <span>{item.label}</span>
              <strong>{formatUsdFromCents(item.amountCents)}</strong>
            </li>
          ))}
        </ul>
      ) : (
        <p className={styles.billingEmptyHint}>
          No usage recorded this cycle yet. SMS and AI costs will roll up here.
        </p>
      )}
    </section>
  );
}
