import { NewTaskModal } from "./_components/new-task-modal";
import { EmptyState } from "@/components/shell/empty-state";
import { PageHeading } from "@/components/shell/page-heading";
import { IconTasks } from "@/components/shell/sidebar-nav";
import { fetchTasksList, listLeadOptionsForTenant } from "@/lib/crm/crm-lists";
import { resolveCurrentTenant, workspaceUnavailableMessage } from "@/lib/tenant/current-tenant";
import { displayValue } from "@/lib/display-value";
import { formatRelativeTime } from "@/lib/admin/activity-timeline";
import styles from "@/components/shell/shell.module.css";

function formatDueDate(value: string | null): string {
  if (!value) return displayValue(null);
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  }).format(new Date(value));
}

export default async function TasksPage() {
  const { tenantId, reason } = await resolveCurrentTenant();

  if (!tenantId) {
    return (
      <>
        <div className={styles.pageHeader}>
          <PageHeading
            icon={<IconTasks />}
            title="Tasks"
            tone="light"
          />
        </div>
        <p className={styles.empty}>{workspaceUnavailableMessage(reason)}</p>
      </>
    );
  }

  const [rows, leadOptions] = await Promise.all([
    fetchTasksList(tenantId),
    listLeadOptionsForTenant(),
  ]);

  return (
    <>
      <div className={styles.pageHeader}>
        <PageHeading
          icon={<IconTasks />}
          title="Tasks"
          tone="light"
        />
        <div className={styles.pageHeaderActions}>
          <NewTaskModal leadOptions={leadOptions} />
        </div>
      </div>

      {rows.length === 0 ? (
        <EmptyState
          title="Stay on top of every follow-up"
          description="Add tasks so nothing slips through the cracks."
          action={<NewTaskModal trigger="cta" leadOptions={leadOptions} />}
        />
      ) : (
        <div className={styles.tableWrap}>
          <table className={styles.table}>
            <thead>
              <tr>
                <th>Title</th>
                <th>Lead</th>
                <th>Status</th>
                <th>Due</th>
                <th>Updated</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.id}>
                  <td>
                    <span className={styles.tableCellName}>{row.title}</span>
                  </td>
                  <td>{row.contactName ?? displayValue(null)}</td>
                  <td>
                    <span
                      className={`${styles.badge} ${
                        row.status === "done" ? styles.badgeLeadConverted : styles.badgeLeadNew
                      }`}
                    >
                      {row.status === "done" ? "Done" : "Open"}
                    </span>
                  </td>
                  <td>{formatDueDate(row.dueAt)}</td>
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
