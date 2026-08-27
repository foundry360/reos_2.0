import Link from "next/link";
import { formatUsdFromCents } from "@/lib/admin/billing-stats";
import {
  BillingStatCard,
  IconBillingTopSpender,
} from "./billing-stat-card";
import styles from "@/components/shell/shell.module.css";

interface TopSpender {
  name: string;
  cycleUsageCents: number;
  href: string;
}

interface BillingTopSpenderCardProps {
  topSpender?: TopSpender | null;
  scopedToTenant?: boolean;
}

export function BillingTopSpenderCard({
  topSpender,
  scopedToTenant = false,
}: BillingTopSpenderCardProps) {
  return (
    <BillingStatCard label="Top spender" icon={<IconBillingTopSpender />} iconTone="purple">
      {scopedToTenant ? (
        <>
          <p className={`${styles.billingStatStatus} ${styles.billingStatStatusMuted}`}>
            Fleet view only
          </p>
          <p className={styles.dashStatHint}>
            Select <strong>All tenants</strong> in the header to compare top spenders.
          </p>
        </>
      ) : topSpender ? (
        <>
          <p className={styles.billingStatValue}>
            {formatUsdFromCents(topSpender.cycleUsageCents)}
          </p>
          <p className={styles.dashStatHint}>
            <Link href={topSpender.href} className={styles.billingTopSpenderLink}>
              {topSpender.name}
            </Link>
          </p>
        </>
      ) : (
        <>
          <p className={`${styles.billingStatStatus} ${styles.billingStatStatusMuted}`}>—</p>
          <p className={styles.dashStatHint}>No usage recorded this cycle</p>
        </>
      )}
    </BillingStatCard>
  );
}
