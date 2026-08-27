import Link from "next/link";
import { notFound } from "next/navigation";
import { AccountActivityTimeline } from "./_components/account-activity-timeline";
import { AccountDetailTabs } from "./_components/account-detail-tabs";
import { AccountHighlightsPanel } from "./_components/account-highlights-panel";
import { AccountSetupChevron } from "./_components/account-setup-chevron";
import { AccountUsageWallet } from "../../_components/account-usage-wallet";
import { listPlatformAdminOptions } from "@/lib/admin/platform-admin-actions";
import { fetchTenantUsageSummary } from "@/lib/admin/billing-stats";
import { buildSetupChecklist } from "@/lib/admin/setup-checklist";
import { getTenantConfig } from "@/lib/admin/tenant-config";
import { getTenantUsers } from "@/lib/admin/tenant-users";
import styles from "@/components/shell/shell.module.css";

interface PageProps {
  params: Promise<{ id: string }>;
  searchParams: Promise<{
    created?: string;
    meta_connected?: string;
    meta_error?: string;
  }>;
}

function metaFeedbackMessage(searchParams: {
  meta_connected?: string;
  meta_error?: string;
}): { kind: "success" | "error"; text: string } | null {
  if (searchParams.meta_connected === "messenger") {
    return { kind: "success", text: "Facebook Messenger connected." };
  }
  if (searchParams.meta_connected === "instagram") {
    return { kind: "success", text: "Instagram connected." };
  }
  if (searchParams.meta_error === "not_configured") {
    return {
      kind: "error",
      text: "Meta OAuth is not configured. Add META_APP_ID and META_APP_SECRET.",
    };
  }
  if (searchParams.meta_error) {
    return { kind: "error", text: searchParams.meta_error };
  }
  return null;
}

export default async function AccountDetailPage({ params, searchParams }: PageProps) {
  const { id } = await params;
  const query = await searchParams;
  const [tenant, platformAdmins, users, usageSummary] = await Promise.all([
    getTenantConfig(id),
    listPlatformAdminOptions(),
    getTenantUsers(id),
    fetchTenantUsageSummary(id),
  ]);

  if (!tenant) notFound();

  const checklist = buildSetupChecklist(tenant, users);
  const metaFeedback = metaFeedbackMessage(query);

  return (
    <>
      <div className={styles.pageHeader}>
        <div>
          <h1 className={styles.pageTitle}>{tenant.name}</h1>
        </div>
        <div className={styles.pageHeaderActions}>
          <Link href="/admin" className={`${styles.btnPrimary} ${styles.btnPill}`}>
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true">
              <path
                d="M19 12H5M12 19l-7-7 7-7"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
            Back to accounts
          </Link>
        </div>
      </div>

      {query.created === "1" && <p className={styles.success}>Account created.</p>}
      {metaFeedback?.kind === "success" && (
        <p className={styles.success}>{metaFeedback.text}</p>
      )}
      {metaFeedback?.kind === "error" && (
        <p className={styles.error}>{metaFeedback.text}</p>
      )}

      <AccountHighlightsPanel tenant={tenant} platformAdmins={platformAdmins} />

      <AccountSetupChevron
        tenantId={tenant.id}
        currentStatus={tenant.status}
        checklist={checklist}
      />

      <AccountUsageWallet
        tenantId={tenant.id}
        cycle={usageSummary.cycle}
        totalUsageCents={usageSummary.totalUsageCents}
        categoryTotals={usageSummary.categoryTotals}
      />

      <div className={styles.accountDetailLayout}>
        <AccountDetailTabs tenant={tenant} users={users} />
        <AccountActivityTimeline tenant={tenant} userCount={users.length} />
      </div>
    </>
  );
}
