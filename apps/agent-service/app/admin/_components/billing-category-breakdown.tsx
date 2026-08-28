import {
  formatUsdFromCents,
  type UsageCategoryTotal,
} from "@/lib/admin/billing-stats";
import type { UsageCategory } from "@/lib/admin/billing-categories";
import styles from "@/components/shell/shell.module.css";

const CATEGORY_FILL_CLASS: Record<UsageCategory, string> = {
  twilio_sms: styles.billingCategoryFillTwilioSms,
  twilio_number: styles.billingCategoryFillTwilioNumber,
  ai_tokens: styles.billingCategoryFillAiTokens,
  other: styles.billingCategoryFillOther,
};

export function BillingCategoryBreakdown({ items }: { items: UsageCategoryTotal[] }) {
  const max = Math.max(1, ...items.map((item) => item.amountCents));

  return (
    <div className={styles.billingCategoryList}>
      {items.map((item) => (
        <div key={item.category} className={styles.billingCategoryRow}>
          <span className={styles.billingCategoryLabel}>{item.label}</span>
          <span className={styles.billingCategoryTrack}>
            <span
              className={`${styles.billingCategoryFill} ${CATEGORY_FILL_CLASS[item.category]}`}
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
