import { createClient } from "@/lib/supabase/server";
import {
  normalizeTenantStatus,
  TENANT_STATUS_OPTIONS,
  type TenantStatus,
} from "@/lib/admin/account-status";

const STUCK_DAYS = 7;
const MS_PER_DAY = 86_400_000;

export interface DashboardStatusCount {
  status: TenantStatus;
  label: string;
  count: number;
}

export interface DashboardAttentionItem {
  id: string;
  name: string;
  slug: string;
  status: TenantStatus;
  reason: string;
  href: string;
}

export interface DashboardRecentAccount {
  id: string;
  name: string;
  slug: string;
  status: TenantStatus;
  createdAt: string;
  href: string;
}

export interface DashboardStats {
  totalAccounts: number;
  activeCount: number;
  pausedCount: number;
  onboardingCount: number;
  readyToActivateCount: number;
  missingPhoneCount: number;
  missingBillingCount: number;
  activePercent: number;
  createdLast7Days: number;
  createdLast30Days: number;
  statusCounts: DashboardStatusCount[];
  attentionItems: DashboardAttentionItem[];
  recentAccounts: DashboardRecentAccount[];
}

interface TenantRow {
  id: string;
  name: string;
  slug: string;
  status: string;
  stripe_customer_id: string | null;
  created_at: string;
  updated_at: string;
}

export async function fetchDashboardStats(): Promise<DashboardStats> {
  const supabase = await createClient();

  const { data: tenants, error } = await supabase
    .from("tenants")
    .select("id, name, slug, status, stripe_customer_id, created_at, updated_at")
    .order("created_at", { ascending: false });

  if (error) {
    console.error("dashboard tenants query failed:", error.message);
    return emptyStats();
  }

  const rows = (tenants ?? []) as TenantRow[];
  const tenantIds = rows.map((row) => row.id);

  const { data: phones } =
    tenantIds.length > 0
      ? await supabase
          .from("tenant_phone_numbers")
          .select("tenant_id")
          .in("tenant_id", tenantIds)
          .eq("is_primary", true)
      : { data: [] };

  const phoneTenantIds = new Set((phones ?? []).map((row) => row.tenant_id as string));

  const counts = Object.fromEntries(
    TENANT_STATUS_OPTIONS.map((option) => [option.value, 0]),
  ) as Record<TenantStatus, number>;

  const now = Date.now();
  let createdLast7Days = 0;
  let createdLast30Days = 0;
  let missingPhoneCount = 0;
  let missingBillingCount = 0;
  let readyToActivateCount = 0;
  const attentionItems: DashboardAttentionItem[] = [];

  for (const row of rows) {
    const status = normalizeTenantStatus(row.status);
    counts[status] += 1;

    const createdMs = new Date(row.created_at).getTime();
    const updatedMs = new Date(row.updated_at).getTime();
    const ageDays = (now - createdMs) / MS_PER_DAY;
    const staleDays = (now - updatedMs) / MS_PER_DAY;

    if (ageDays <= 7) createdLast7Days += 1;
    if (ageDays <= 30) createdLast30Days += 1;

    const hasPhone = phoneTenantIds.has(row.id);
    const hasBilling = Boolean(row.stripe_customer_id);

    if (!hasPhone) missingPhoneCount += 1;
    if (!hasBilling) missingBillingCount += 1;
    if (status === "testing") readyToActivateCount += 1;

    const href = `/admin/accounts/${row.id}`;
    const onboarding = status !== "active" && status !== "paused";

    if (status === "testing") {
      attentionItems.push({
        id: `${row.id}-ready`,
        name: row.name,
        slug: row.slug,
        status,
        reason: "Ready to activate",
        href,
      });
    } else if (status === "active" && !hasPhone) {
      attentionItems.push({
        id: `${row.id}-phone`,
        name: row.name,
        slug: row.slug,
        status,
        reason: "Active without phone number",
        href,
      });
    } else if (onboarding && staleDays >= STUCK_DAYS) {
      attentionItems.push({
        id: `${row.id}-stuck`,
        name: row.name,
        slug: row.slug,
        status,
        reason: `No progress for ${Math.floor(staleDays)} days`,
        href,
      });
    }
  }

  const activeCount = counts.active;
  const pausedCount = counts.paused;
  const totalAccounts = rows.length;
  const onboardingCount = totalAccounts - activeCount - pausedCount;
  const activePercent =
    totalAccounts > 0 ? Math.round((activeCount / totalAccounts) * 100) : 0;

  const seen = new Set<string>();
  const prioritizedAttention = attentionItems
    .sort((a, b) => {
      const rank = (item: DashboardAttentionItem) =>
        item.reason.startsWith("Ready")
          ? 0
          : item.reason.includes("without phone")
            ? 1
            : 2;
      return rank(a) - rank(b) || a.name.localeCompare(b.name);
    })
    .filter((item) => {
      const key = item.href;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, 8);

  return {
    totalAccounts,
    activeCount,
    pausedCount,
    onboardingCount,
    readyToActivateCount,
    missingPhoneCount,
    missingBillingCount,
    activePercent,
    createdLast7Days,
    createdLast30Days,
    statusCounts: TENANT_STATUS_OPTIONS.map((option) => ({
      status: option.value,
      label: option.label,
      count: counts[option.value],
    })),
    attentionItems: prioritizedAttention,
    recentAccounts: rows.slice(0, 6).map((row) => ({
      id: row.id,
      name: row.name,
      slug: row.slug,
      status: normalizeTenantStatus(row.status),
      createdAt: row.created_at,
      href: `/admin/accounts/${row.id}`,
    })),
  };
}

function emptyStats(): DashboardStats {
  return {
    totalAccounts: 0,
    activeCount: 0,
    pausedCount: 0,
    onboardingCount: 0,
    readyToActivateCount: 0,
    missingPhoneCount: 0,
    missingBillingCount: 0,
    activePercent: 0,
    createdLast7Days: 0,
    createdLast30Days: 0,
    statusCounts: TENANT_STATUS_OPTIONS.map((option) => ({
      status: option.value,
      label: option.label,
      count: 0,
    })),
    attentionItems: [],
    recentAccounts: [],
  };
}
