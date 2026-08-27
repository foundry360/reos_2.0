import Link from "next/link";
import { AccountsHeaderActions } from "./_components/accounts-header-actions";
import { AccountsPagination } from "./_components/accounts-pagination";
import { AccountsViewTabs } from "./_components/accounts-view-tabs";
import { NewAccountModal } from "./_components/new-account-modal";
import { OnboardingKanban } from "./_components/onboarding-kanban";
import {
  fetchAccountsList,
  fetchOnboardingKanbanAccounts,
  parseAccountsListParams,
} from "@/lib/admin/accounts-list";
import {
  buildSortHref,
  type AccountSortColumn,
  type AccountsListParams,
} from "@/lib/admin/accounts-list-params";
import { AccountStatusBadge } from "@/lib/admin/account-status";
import styles from "@/components/shell/shell.module.css";
import { formatPhoneDisplay } from "@/lib/phone-display";
import { accountInitials } from "@/lib/user-display";

interface PageProps {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

function IconSort({ direction }: { direction: "asc" | "desc" | null }) {
  const upOpacity = direction === "desc" ? 0.35 : direction === "asc" ? 1 : 0.55;
  const downOpacity = direction === "asc" ? 0.35 : direction === "desc" ? 1 : 0.55;

  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path
        d="M8 9l4-4 4 4"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        opacity={upOpacity}
      />
      <path
        d="M8 15l4 4 4-4"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        opacity={downOpacity}
      />
    </svg>
  );
}

function SortHeader({
  label,
  column,
  params,
}: {
  label: string;
  column: AccountSortColumn;
  params: AccountsListParams;
}) {
  const active = params.sort === column;
  const nextDir = active && params.dir === "asc" ? "descending" : "ascending";

  return (
    <div className={styles.tableSortHeader}>
      <span>{label}</span>
      <Link
        href={`/admin${buildSortHref(params, column)}`}
        className={`${styles.tableSortBtn} ${active ? styles.tableSortBtnActive : ""}`}
        aria-label={`Sort by ${label} ${nextDir}`}
      >
        <IconSort direction={active ? params.dir : null} />
      </Link>
    </div>
  );
}

export default async function AdminAccountsPage({ searchParams }: PageProps) {
  const resolved = await searchParams;
  const params = parseAccountsListParams(resolved);
  const isOnboardingView = params.view === "onboarding";

  const listResult = isOnboardingView ? null : await fetchAccountsList(params);
  const kanbanResult = isOnboardingView
    ? await fetchOnboardingKanbanAccounts(params.q)
    : null;

  const rows = listResult?.rows ?? [];
  const total = listResult?.total ?? kanbanResult?.total ?? 0;
  const hasFilters = params.q.length > 0;

  return (
    <>
      <div className={styles.pageHeader}>
        <div>
          <h1 className={styles.pageTitle}>Accounts</h1>
        </div>
        <div className={styles.pageHeaderActions}>
          <AccountsHeaderActions params={params} />
          <NewAccountModal />
        </div>
      </div>

      <AccountsViewTabs params={params} />

      {isOnboardingView ? (
        kanbanResult && total === 0 ? (
          <p className={styles.empty}>
            {hasFilters ? (
              "No onboarding accounts match your search."
            ) : (
              <>
                No accounts in onboarding. <NewAccountModal trigger="link" />.
              </>
            )}
          </p>
        ) : (
          kanbanResult && <OnboardingKanban columns={kanbanResult.columns} />
        )
      ) : rows.length === 0 ? (
        <p className={styles.empty}>
          {hasFilters ? (
            "No accounts match your filters."
          ) : (
            <>
              No active accounts yet. <NewAccountModal trigger="link" />.
            </>
          )}
        </p>
      ) : (
        <>
          <div className={styles.tableWrap}>
            <table className={styles.table}>
              <thead>
                <tr>
                  <th>
                    <SortHeader label="Name" column="name" params={params} />
                  </th>
                  <th>
                    <SortHeader label="Account Name" column="slug" params={params} />
                  </th>
                  <th>
                    <SortHeader label="Status" column="status" params={params} />
                  </th>
                  <th>Phone</th>
                  <th>
                    <SortHeader label="Timezone" column="timezone" params={params} />
                  </th>
                </tr>
              </thead>
              <tbody>
                {rows.map((tenant) => (
                  <tr key={tenant.id}>
                    <td>
                      <div className={styles.tableCellPerson}>
                        <span className={styles.avatar}>
                          {accountInitials(tenant.name)}
                        </span>
                        <Link href={`/admin/accounts/${tenant.id}`} className={styles.tableCellLink}>
                          {tenant.name}
                        </Link>
                      </div>
                    </td>
                    <td>{tenant.slug}</td>
                    <td>
                      <AccountStatusBadge status={tenant.status} />
                    </td>
                    <td>{formatPhoneDisplay(tenant.phone) ?? "None"}</td>
                    <td>{tenant.timezone.replace("_", " ")}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <AccountsPagination params={params} total={total} />
          </div>
        </>
      )}
    </>
  );
}
