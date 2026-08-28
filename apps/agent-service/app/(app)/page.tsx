import { PageHeading } from "@/components/shell/page-heading";
import { IconHome } from "@/components/shell/sidebar-nav";
import { resolveCurrentTenant, workspaceUnavailableMessage } from "@/lib/tenant/current-tenant";
import styles from "@/components/shell/shell.module.css";

export default async function OverviewPage() {
  const { tenantId, reason } = await resolveCurrentTenant();

  return (
    <>
      <div className={styles.pageHeader}>
        <PageHeading
          icon={<IconHome />}
          title="Overview"
          tone="brand"
        />
      </div>

      {!tenantId ? (
        <p className={styles.empty}>{workspaceUnavailableMessage(reason)}</p>
      ) : (
        <div className={styles.card} style={{ padding: "1.25rem" }}>
          <p style={{ margin: 0, color: "var(--shell-text-secondary)", lineHeight: 1.5 }}>
            Your leads, opportunities, and tasks live in this workspace. Use the sidebar to get
            started.
          </p>
        </div>
      )}
    </>
  );
}
