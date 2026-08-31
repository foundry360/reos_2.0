import Link from "next/link";
import { Suspense } from "react";
import { notFound } from "next/navigation";
import { AccountActivityTimeline } from "./_components/account-activity-timeline";
import { AccountDetailTabs } from "./_components/account-detail-tabs";
import { AccountFlashBanner } from "./_components/account-flash-banner";
import { AccountHighlightsPanel } from "./_components/account-highlights-panel";
import { AccountSetupChevron } from "./_components/account-setup-chevron";
import { AccountUsageWallet } from "../../_components/account-usage-wallet";
import { listPlatformAdminOptions } from "@/lib/admin/platform-admin-actions";
import { fetchTenantUsageSummary } from "@/lib/admin/billing-stats";
import { buildSetupChecklist } from "@/lib/admin/setup-checklist";
import { getTenantConfig } from "@/lib/admin/tenant-config";
import { getTenantUsers } from "@/lib/admin/tenant-users";
import { PageHeading } from "@/components/shell/page-heading";
import { IconBuilding } from "@/components/shell/sidebar-nav";
import styles from "@/components/shell/shell.module.css";

interface PageProps {
  params: Promise<{ id: string }>;
  searchParams: Promise<{
    created?: string;
    meta_select_page?: string;
    meta_error?: string;
    google_connected?: string;
    google_error?: string;
    tab?: string;
  }>;
}

function channelFeedbackMessage(searchParams: {
  meta_error?: string;
  google_connected?: string;
  google_error?: string;
}): { kind: "success" | "error"; text: string } | null {
  if (searchParams.google_connected === "email") {
    return { kind: "success", text: "Gmail connected." };
  }
  if (searchParams.google_connected === "calendar") {
    return { kind: "success", text: "Google Calendar connected." };
  }
  if (searchParams.google_error === "not_configured") {
    return {
      kind: "error",
      text: "Google OAuth is not configured. Add GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET.",
    };
  }
  if (searchParams.google_error) {
    return { kind: "error", text: searchParams.google_error };
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
  const metaFeedback = channelFeedbackMessage(query);
  const initialTab = query.tab === "details" ? "details" : "general";

  return (
    <>
      <div className={styles.pageHeader}>
        <PageHeading icon={<IconBuilding />} title={tenant.name} tone="brand" />
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
            Back To Accounts
          </Link>
        </div>
      </div>

      {(query.created === "1" || metaFeedback) && (
        <Suspense fallback={null}>
          <AccountFlashBanner
            kind={metaFeedback?.kind === "error" ? "error" : "success"}
            text={
              metaFeedback?.text ??
              (query.created === "1" ? "Account created." : "")
            }
          />
        </Suspense>
      )}

      <AccountHighlightsPanel tenant={tenant} platformAdmins={platformAdmins} />

      <AccountSetupChevron
        tenantId={tenant.id}
        currentStatus={tenant.status}
        checklist={checklist}
      />

      <div className={styles.accountDetailLayout}>
        <AccountDetailTabs tenant={tenant} users={users} initialTab={initialTab} />
        <div className={styles.accountDetailSidebar}>
          <AccountUsageWallet
            tenantId={tenant.id}
            cycle={usageSummary.cycle}
            totalUsageCents={usageSummary.totalUsageCents}
            categoryTotals={usageSummary.categoryTotals}
          />
          <AccountActivityTimeline tenant={tenant} userCount={users.length} />
        </div>
      </div>
    </>
  );
}
