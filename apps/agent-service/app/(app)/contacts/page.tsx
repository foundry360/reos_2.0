import { ExportLeadsButton } from "../leads/_components/export-leads-button";
import { LeadsHeaderActions } from "../leads/_components/leads-header-actions";
import { LeadsTable } from "../leads/_components/leads-table";
import { NewLeadModal } from "../leads/_components/new-lead-modal";
import { PeopleKanban } from "../leads/_components/people-kanban";
import { PeopleLayoutToggle } from "../leads/_components/people-layout-toggle";
import { EmptyState } from "@/components/shell/empty-state";
import { PageHeading } from "@/components/shell/page-heading";
import { IconUsers } from "@/components/shell/sidebar-nav";
import {
  fetchLeadsList,
  fetchPeopleKanban,
  parseLeadsListParams,
} from "@/lib/leads/leads-list";
import { leadViewLabel } from "@/lib/leads/leads-views";
import { resolveCurrentTenant, workspaceUnavailableMessage } from "@/lib/tenant/current-tenant";
import styles from "@/components/shell/shell.module.css";

interface PageProps {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

export default async function ContactsPage({ searchParams }: PageProps) {
  const resolved = await searchParams;
  const params = parseLeadsListParams(resolved);
  const { tenantId, reason } = await resolveCurrentTenant();

  if (!tenantId) {
    return (
      <>
        <div className={styles.pageHeader}>
          <PageHeading icon={<IconUsers />} title="Contacts" tone="person" />
        </div>
        <p className={styles.empty}>{workspaceUnavailableMessage(reason)}</p>
      </>
    );
  }

  const isKanban = params.layout === "kanban";
  const listResult = isKanban
    ? null
    : await fetchLeadsList(tenantId, params, { kind: "contact" });
  const kanbanResult = isKanban
    ? await fetchPeopleKanban(tenantId, params, { kind: "contact" })
    : null;

  const total = listResult?.total ?? kanbanResult?.total ?? 0;
  const hasFilters =
    params.q.length > 0 ||
    params.status !== "all" ||
    (params.view !== "all" &&
      !["new", "working", "contacted", "qualified", "converted"].includes(params.view));
  const pageTitle = leadViewLabel(params.view, "contact");
  const showKanbanLayout = isKanban && total > 0 && Boolean(kanbanResult);

  return (
    <div className={showKanbanLayout ? styles.kanbanPage : undefined}>
      <div className={styles.pageHeader}>
        <PageHeading icon={<IconUsers />} title={pageTitle} tone="person" />
        <div className={styles.pageHeaderActions}>
          <PeopleLayoutToggle params={params} kind="contact" />
          <LeadsHeaderActions params={params} kind="contact" />
          <ExportLeadsButton params={params} kind="contact" />
          <NewLeadModal kind="contact" />
        </div>
      </div>

      {total === 0 ? (
        hasFilters || params.view !== "all" || params.status !== "all" || params.q ? (
          <EmptyState compact title="No contacts match your filters." />
        ) : (
          <EmptyState
            title="Top sellers add their contacts first"
            description="It's the fastest way to win more deals."
            action={<NewLeadModal kind="contact" trigger="cta" />}
          />
        )
      ) : isKanban && kanbanResult ? (
        <PeopleKanban columns={kanbanResult.columns} kind="contact" />
      ) : listResult ? (
        <LeadsTable
          rows={listResult.rows}
          params={params}
          total={listResult.total}
          kind="contact"
        />
      ) : null}
    </div>
  );
}
