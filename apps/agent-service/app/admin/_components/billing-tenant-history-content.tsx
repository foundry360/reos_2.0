"use client";

import { Fragment, useState } from "react";
import { BillingCategoryBreakdown } from "./billing-category-breakdown";
import { formatUsdFromCents } from "@/lib/admin/billing-format";
import type {
  BillingCycleStatus,
  TenantBillingHistory,
} from "@/lib/admin/billing-stats";
import styles from "@/components/shell/shell.module.css";

const STATUS_LABELS: Record<BillingCycleStatus, string> = {
  open: "Open",
  closing: "Closing",
  invoiced: "Invoiced",
  paid: "Paid",
  failed: "Failed",
  unbilled: "Unbilled",
};

function stripeInvoiceUrl(invoiceId: string): string {
  return `https://dashboard.stripe.com/invoices/${invoiceId}`;
}

function AccordionChevron({ open }: { open: boolean }) {
  return (
    <svg
      className={`${styles.billingHistoryChevron} ${open ? styles.billingHistoryChevronOpen : ""}`}
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      aria-hidden="true"
    >
      <path
        d="M6 9l6 6 6-6"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export function BillingTenantHistoryContent({
  history,
}: {
  history: TenantBillingHistory;
}) {
  const [openPeriod, setOpenPeriod] = useState<string | null>(null);

  function togglePeriod(periodKey: string) {
    setOpenPeriod((current) => (current === periodKey ? null : periodKey));
  }

  return (
    <div className={styles.tableWrap}>
      <table className={styles.table}>
        <thead>
          <tr>
            <th>Month</th>
            <th>Status</th>
            <th>Usage</th>
            <th>Invoice</th>
            <th className={styles.tableActionCol} aria-label="Expand" />
          </tr>
        </thead>
        <tbody>
          {history.months.length === 0 ? (
            <tr>
              <td colSpan={5} className={styles.tableEmptyCell}>
                No previous billing months yet. Usage will appear here after the first
                completed cycle.
              </td>
            </tr>
          ) : (
            history.months.map((month) => {
              const open = openPeriod === month.periodKey;
              const panelId = `billing-history-${month.periodKey}`;

              return (
                <Fragment key={month.periodKey}>
                  <tr>
                    <td>
                      <button
                        type="button"
                        className={styles.billingHistoryMonthButton}
                        aria-expanded={open}
                        aria-controls={panelId}
                        onClick={() => togglePeriod(month.periodKey)}
                      >
                        <span className={styles.tableCellName}>{month.cycle.label}</span>
                      </button>
                    </td>
                    <td>{STATUS_LABELS[month.status]}</td>
                    <td className={styles.billingAmountCell}>
                      {formatUsdFromCents(month.totalUsageCents)}
                    </td>
                    <td>
                      {month.stripeInvoiceId ? (
                        <a
                          href={stripeInvoiceUrl(month.stripeInvoiceId)}
                          className={styles.tableCellLink}
                          target="_blank"
                          rel="noopener noreferrer"
                          onClick={(e) => e.stopPropagation()}
                        >
                          View invoice
                        </a>
                      ) : (
                        "—"
                      )}
                    </td>
                    <td className={`${styles.tableActionCol} ${styles.tableActionsCell}`}>
                      <button
                        type="button"
                        className={styles.billingHistoryToggle}
                        aria-label={`${open ? "Collapse" : "Expand"} ${month.cycle.label}`}
                        aria-expanded={open}
                        aria-controls={panelId}
                        onClick={() => togglePeriod(month.periodKey)}
                      >
                        <AccordionChevron open={open} />
                      </button>
                    </td>
                  </tr>
                  {open ? (
                    <tr id={panelId} className={styles.billingHistoryDetailRow}>
                      <td colSpan={5}>
                        <div className={styles.billingHistoryDetail}>
                          <BillingCategoryBreakdown items={month.categoryTotals} />
                        </div>
                      </td>
                    </tr>
                  ) : null}
                </Fragment>
              );
            })
          )}
        </tbody>
      </table>
    </div>
  );
}
