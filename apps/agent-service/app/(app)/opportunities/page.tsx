import { NewOpportunityModal } from "./_components/new-opportunity-modal";
import { EmptyState } from "@/components/shell/empty-state";
import { PageHeading } from "@/components/shell/page-heading";
import { IconPipeline } from "@/components/shell/sidebar-nav";
import { fetchOpportunitiesList, listLeadOptionsForTenant } from "@/lib/crm/crm-lists";
import { resolveCurrentTenant, workspaceUnavailableMessage } from "@/lib/tenant/current-tenant";
import { displayValue } from "@/lib/display-value";
import { formatRelativeTime } from "@/lib/admin/activity-timeline";
import styles from "@/components/shell/shell.module.css";

function formatUsd(cents: number | null): string {
  if (cents == null) return displayValue(null);
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 0,
  }).format(cents / 100);
}

function formatDate(value: string | null): string {
  if (!value) return displayValue(null);
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  }).format(new Date(`${value}T12:00:00`));
}

export default async function OpportunitiesPage() {
  const { tenantId, reason } = await resolveCurrentTenant();

  if (!tenantId) {
    return (
      <>
        <div className={styles.pageHeader}>
          <PageHeading
            icon={<IconPipeline />}
            title="Opportunities"
            tone="dark"
          />
        </div>
        <p className={styles.empty}>{workspaceUnavailableMessage(reason)}</p>
      </>
    );
  }

  const [rows, leadOptions] = await Promise.all([
    fetchOpportunitiesList(tenantId),
    listLeadOptionsForTenant(),
  ]);

  return (
    <>
      <div className={styles.pageHeader}>
        <PageHeading
          icon={<IconPipeline />}
          title="Opportunities"
          tone="dark"
        />
        <div className={styles.pageHeaderActions}>
          <NewOpportunityModal leadOptions={leadOptions} />
        </div>
      </div>

      {rows.length === 0 ? (
        <EmptyState
          title="Top sellers track opportunities early"
          description="Keep every deal moving in one place."
          action={<NewOpportunityModal trigger="cta" leadOptions={leadOptions} />}
        />
      ) : (
        <div className={styles.tableWrap}>
          <table className={styles.table}>
            <thead>
              <tr>
                <th>Name</th>
                <th>Lead</th>
                <th>Stage</th>
                <th>Amount</th>
                <th>Expected close</th>
                <th>Updated</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.id}>
                  <td>
                    <span className={styles.tableCellName}>{row.name}</span>
                  </td>
                  <td>{row.contactName ?? displayValue(null)}</td>
                  <td>
                    <span className={`${styles.badge} ${styles.badgeLeadContacted}`}>
                      {row.stageLabel}
                    </span>
                  </td>
                  <td>{formatUsd(row.amountCents)}</td>
                  <td>{formatDate(row.expectedCloseDate)}</td>
                  <td>
                    <time dateTime={row.updatedAt}>{formatRelativeTime(row.updatedAt)}</time>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}
