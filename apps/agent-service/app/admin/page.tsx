import { ActiveAccountsKanban } from "./_components/active-accounts-kanban";
import { AccountsHeaderActions } from "./_components/accounts-header-actions";
import { AccountsLayoutToggle } from "./_components/accounts-layout-toggle";
import { AccountsTable } from "./_components/accounts-table";
import { AccountsViewTabs } from "./_components/accounts-view-tabs";
import { ExportAdminButton } from "./_components/export-admin-button";
import { NewAccountModal } from "./_components/new-account-modal";
import { OnboardingKanban } from "./_components/onboarding-kanban";
import { EmptyState } from "@/components/shell/empty-state";
import { PageHeading } from "@/components/shell/page-heading";
import { IconBuilding } from "@/components/shell/sidebar-nav";
import {
  buildAccountsListQuery,
  fetchAccountsList,
  fetchActiveKanbanAccounts,
  fetchOnboardingKanbanAccounts,
  parseAccountsListParams,
} from "@/lib/admin/accounts-list";
import styles from "@/components/shell/shell.module.css";

interface PageProps {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

export default async function AdminAccountsPage({ searchParams }: PageProps) {
  const resolved = await searchParams;
  const params = parseAccountsListParams(resolved);
  const isOnboardingView = params.view === "onboarding";
  const isKanban = params.layout === "kanban";

  const listResult = isKanban ? null : await fetchAccountsList(params);
  const onboardingKanban =
    isKanban && isOnboardingView ? await fetchOnboardingKanbanAccounts(params.q) : null;
  const activeKanban =
    isKanban && !isOnboardingView
      ? await fetchActiveKanbanAccounts(params.q, params.status)
      : null;

  const rows = listResult?.rows ?? [];
  const total =
    listResult?.total ?? onboardingKanban?.total ?? activeKanban?.total ?? 0;
  const hasFilters = params.q.length > 0 || params.status !== "all";
  const showKanbanLayout =
    isKanban && total > 0 && Boolean(onboardingKanban ?? activeKanban);

  return (
    <div className={showKanbanLayout ? styles.kanbanPage : undefined}>
      <div className={styles.pageHeader}>
        <PageHeading icon={<IconBuilding />} title="Accounts" tone="brand" />
        <div className={styles.pageHeaderActions}>
          <AccountsLayoutToggle params={params} />
          <AccountsHeaderActions params={params} />
          {!isKanban && (
            <ExportAdminButton href={`/api/admin/accounts/export${buildAccountsListQuery(params)}`} />
          )}
          <NewAccountModal />
        </div>
      </div>

      <AccountsViewTabs params={params} />

      {total === 0 ? (
        hasFilters ? (
          <EmptyState
            compact
            title={
              isOnboardingView
                ? "No onboarding accounts match your search."
                : "No accounts match your filters."
            }
          />
        ) : isOnboardingView ? (
          <EmptyState
            title="No accounts in onboarding"
            description="Create an account to start the onboarding pipeline."
            action={<NewAccountModal trigger="cta" />}
          />
        ) : (
          <EmptyState
            title="Create your first account"
            description="Accounts are workspaces for each brokerage or client."
            action={<NewAccountModal trigger="cta" />}
          />
        )
      ) : isKanban ? (
        onboardingKanban ? (
          <OnboardingKanban columns={onboardingKanban.columns} />
        ) : activeKanban ? (
          <ActiveAccountsKanban
            columns={activeKanban.columns}
            showPaused={params.status === "all" || params.status === "paused"}
          />
        ) : null
      ) : listResult ? (
        <AccountsTable rows={rows} params={params} total={total} />
      ) : null}
    </div>
  );
}
