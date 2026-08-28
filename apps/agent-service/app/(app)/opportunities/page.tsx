import { ExportOpportunitiesButton } from "./_components/export-opportunities-button";
import { NewOpportunityModal } from "./_components/new-opportunity-modal";
import { OpportunitiesHeaderActions } from "./_components/opportunities-header-actions";
import { OpportunitiesKanban } from "./_components/opportunities-kanban";
import { OpportunitiesLayoutToggle } from "./_components/opportunities-layout-toggle";
import { OpportunitiesPipelineMenu } from "./_components/opportunities-pipeline-menu";
import { OpportunitiesTable } from "./_components/opportunities-table";
import { EmptyState } from "@/components/shell/empty-state";
import { PageHeading } from "@/components/shell/page-heading";
import { IconPipeline } from "@/components/shell/sidebar-nav";
import {
  listAgentOptionsForTenant,
  listLeadOptionsForTenant,
} from "@/lib/crm/crm-lists";
import {
  fetchOpportunitiesKanban,
  fetchOpportunitiesList,
  parseOpportunitiesListParams,
} from "@/lib/opportunities/opportunities-list";
import { resolveCurrentTenant, workspaceUnavailableMessage } from "@/lib/tenant/current-tenant";
import styles from "@/components/shell/shell.module.css";

interface PageProps {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

export default async function OpportunitiesPage({ searchParams }: PageProps) {
  const resolved = await searchParams;
  const params = parseOpportunitiesListParams(resolved);
  const { tenantId, reason } = await resolveCurrentTenant();

  if (!tenantId) {
    return (
      <>
        <div className={styles.pageHeader}>
          <PageHeading icon={<IconPipeline />} title="Opportunities" tone="opportunity" />
        </div>
        <p className={styles.empty}>{workspaceUnavailableMessage(reason)}</p>
      </>
    );
  }

  const [contactOptions, agentOptions] = await Promise.all([
    listLeadOptionsForTenant(),
    listAgentOptionsForTenant(),
  ]);

  const isKanban = params.layout === "kanban";
  const listResult = isKanban ? null : await fetchOpportunitiesList(tenantId, params);
  const kanbanResult = isKanban
    ? await fetchOpportunitiesKanban(tenantId, params)
    : null;

  const total = listResult?.total ?? kanbanResult?.total ?? 0;
  const hasFilters =
    params.q.length > 0 ||
    params.stage !== "all" ||
    (params.view !== "all" &&
      ![
        "new",
        "ai_qualifying",
        "qualified",
        "appointment_set",
        "nurture",
        "closed_won",
      ].includes(params.view));
  const showKanbanLayout = isKanban && total > 0 && Boolean(kanbanResult);

  return (
    <div className={showKanbanLayout ? styles.kanbanPage : undefined}>
      <div className={styles.pageHeader}>
        <PageHeading
          icon={<IconPipeline />}
          title={<OpportunitiesPipelineMenu params={params} />}
          tone="opportunity"
        />
        <div className={styles.pageHeaderActions}>
          <OpportunitiesLayoutToggle params={params} />
          <OpportunitiesHeaderActions params={params} />
          <ExportOpportunitiesButton params={params} />
          <NewOpportunityModal
            contactOptions={contactOptions}
            agentOptions={agentOptions}
          />
        </div>
      </div>

      {total === 0 ? (
        hasFilters || params.view !== "all" || params.stage !== "all" || params.q ? (
          <EmptyState compact title="No opportunities match your filters." />
        ) : (
          <EmptyState
            title="Top sellers track opportunities early"
            description="Keep every deal moving through Intake in one place."
            action={
              <NewOpportunityModal
                trigger="cta"
                contactOptions={contactOptions}
                agentOptions={agentOptions}
              />
            }
          />
        )
      ) : isKanban && kanbanResult ? (
        <OpportunitiesKanban
          columns={kanbanResult.columns}
          contactOptions={contactOptions}
          agentOptions={agentOptions}
        />
      ) : listResult ? (
        <OpportunitiesTable
          rows={listResult.rows}
          params={params}
          total={listResult.total}
          contactOptions={contactOptions}
          agentOptions={agentOptions}
        />
      ) : null}
    </div>
  );
}
