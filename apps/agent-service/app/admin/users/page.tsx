import { ExportAdminButton } from "../_components/export-admin-button";
import { NewUserModal } from "../_components/new-user-modal";
import { UsersHeaderActions } from "../_components/users-header-actions";
import { UsersKanban } from "../_components/users-kanban";
import { UsersLayoutToggle } from "../_components/users-layout-toggle";
import { UsersTable } from "../_components/users-table";
import { EmptyState } from "@/components/shell/empty-state";
import { PageHeading } from "@/components/shell/page-heading";
import { IconUsers } from "@/components/shell/sidebar-nav";
import Link from "next/link";
import { fetchUsersKanban, fetchUsersList } from "@/lib/admin/users-list";
import { buildUsersListQuery, parseUsersListParams } from "@/lib/admin/users-list-params";
import { listTenantOptions } from "@/lib/admin/tenant-options";
import styles from "@/components/shell/shell.module.css";

interface PageProps {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

export default async function AdminUsersPage({ searchParams }: PageProps) {
  const resolved = await searchParams;
  const params = parseUsersListParams(resolved);
  const isKanban = params.layout === "kanban";

  const [listResult, kanbanResult, tenants] = await Promise.all([
    isKanban ? null : fetchUsersList(params),
    isKanban ? fetchUsersKanban(params) : null,
    listTenantOptions(),
  ]);

  const rows = listResult?.rows ?? [];
  const total = listResult?.total ?? kanbanResult?.total ?? 0;
  const hasFilters = params.q.length > 0 || params.role !== "all";
  const showKanbanLayout = isKanban && total > 0 && Boolean(kanbanResult);

  return (
    <div className={showKanbanLayout ? styles.kanbanPage : undefined}>
      <div className={styles.pageHeader}>
        <PageHeading icon={<IconUsers />} title="Users" tone="accent" />
        <div className={styles.pageHeaderActions}>
          <UsersLayoutToggle params={params} />
          <UsersHeaderActions params={params} />
          {!isKanban && (
            <ExportAdminButton href={`/api/admin/users/export${buildUsersListQuery(params)}`} />
          )}
          <NewUserModal tenants={tenants} />
        </div>
      </div>

      {total === 0 ? (
        hasFilters ? (
          <EmptyState compact title="No users match your filters." />
        ) : tenants.length === 0 ? (
          <EmptyState
            title="Create an account first"
            description="Users belong to an account. Add an account, then invite your team."
            action={
              <Link href="/admin" className={`${styles.btnPrimary} ${styles.btnPill}`}>
                Go to Accounts
              </Link>
            }
          />
        ) : (
          <EmptyState
            title="Invite your team to get started"
            description="Add users so everyone can work in the same workspace."
            action={<NewUserModal trigger="cta" tenants={tenants} />}
          />
        )
      ) : isKanban && kanbanResult ? (
        <UsersKanban columns={kanbanResult.columns} />
      ) : listResult ? (
        <UsersTable rows={rows} params={params} total={total} />
      ) : null}
    </div>
  );
}
