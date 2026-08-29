import { ExportTasksButton } from "./_components/export-tasks-button";
import { NewTaskModal } from "./_components/new-task-modal";
import { TasksHeaderActions } from "./_components/tasks-header-actions";
import { TasksTable } from "./_components/tasks-table";
import { EmptyState } from "@/components/shell/empty-state";
import { PageHeading } from "@/components/shell/page-heading";
import { IconTasks } from "@/components/shell/sidebar-nav";
import { fetchTasksListPaged, parseTasksListParams } from "@/lib/crm/tasks-list";
import { tasksListSections } from "@/lib/crm/tasks-list-params";
import {
  listAgentOptionsForTenant,
  listLeadOptionsForTenant,
  listOpportunityOptionsForTenant,
} from "@/lib/crm/crm-lists";
import { resolveCurrentTenant, workspaceUnavailableMessage } from "@/lib/tenant/current-tenant";
import styles from "@/components/shell/shell.module.css";

interface PageProps {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

export default async function TasksPage({ searchParams }: PageProps) {
  const resolved = await searchParams;
  const params = parseTasksListParams(resolved);
  const { tenantId, reason } = await resolveCurrentTenant();

  if (!tenantId) {
    return (
      <>
        <div className={styles.pageHeader}>
          <PageHeading icon={<IconTasks />} title="Tasks" tone="task" />
        </div>
        <p className={styles.empty}>{workspaceUnavailableMessage(reason)}</p>
      </>
    );
  }

  const sections = tasksListSections(params);
  const showUpcoming = sections.includes("upcoming");
  const showCompleted = sections.includes("completed");

  const upcomingParams = {
    ...params,
    status: "open" as const,
    page: params.page,
  };
  const completedParams = {
    ...params,
    status: "done" as const,
    page: params.cpage,
  };

  const [upcomingResult, completedResult, leadOptions, opportunityOptions, agentOptions] =
    await Promise.all([
      showUpcoming
        ? fetchTasksListPaged(tenantId, upcomingParams)
        : Promise.resolve(null),
      showCompleted
        ? fetchTasksListPaged(tenantId, completedParams)
        : Promise.resolve(null),
      listLeadOptionsForTenant(),
      listOpportunityOptionsForTenant(),
      listAgentOptionsForTenant(),
    ]);

  const hasFilters = params.q.length > 0 || params.view !== "all";
  const listHasRows =
    (upcomingResult?.total ?? 0) > 0 || (completedResult?.total ?? 0) > 0;

  return (
    <>
      <div className={styles.pageHeader}>
        <PageHeading icon={<IconTasks />} title="Tasks" tone="task" />
        <div className={styles.pageHeaderActions}>
          <TasksHeaderActions params={params} />
          <ExportTasksButton params={params} />
          <NewTaskModal
            leadOptions={leadOptions}
            opportunityOptions={opportunityOptions}
            agentOptions={agentOptions}
          />
        </div>
      </div>

      {!listHasRows && !hasFilters ? (
        <EmptyState
          title="Stay on top of every follow-up"
          description="Add tasks so nothing slips through the cracks."
          action={
            <NewTaskModal
              trigger="cta"
              leadOptions={leadOptions}
              opportunityOptions={opportunityOptions}
              agentOptions={agentOptions}
            />
          }
        />
      ) : !listHasRows && hasFilters ? (
        <EmptyState compact title="No tasks match your filters." />
      ) : (
        <div className={styles.tasksTablesStack}>
          {showUpcoming && upcomingResult ? (
            <TasksTable
              title="Upcoming"
              rows={upcomingResult.rows}
              params={params}
              total={upcomingResult.total}
              pageKey="page"
              emptyLabel={
                params.view === "due_soon"
                  ? "No tasks due in the next 7 days."
                  : params.view === "overdue"
                    ? "No overdue tasks."
                    : "No upcoming tasks."
              }
            />
          ) : null}
          {showCompleted && completedResult ? (
            <TasksTable
              title="Completed"
              rows={completedResult.rows}
              params={params}
              total={completedResult.total}
              pageKey="cpage"
              emptyLabel="No completed tasks."
            />
          ) : null}
        </div>
      )}
    </>
  );
}
