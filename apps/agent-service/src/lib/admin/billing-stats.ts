import {
  USAGE_CATEGORIES,
  USAGE_CATEGORY_LABELS,
  type UsageCategory,
} from "@/lib/admin/billing-categories";
import { getCurrentBillingCycle, type BillingCycleWindow } from "@/lib/admin/billing-cycle";
import { normalizeTenantStatus } from "@/lib/admin/account-status";
import { createClient } from "@/lib/supabase/server";

export type { BillingCycleWindow } from "@/lib/admin/billing-cycle";
export { getCurrentBillingCycle } from "@/lib/admin/billing-cycle";

export interface UsageCategoryTotal {
  category: UsageCategory;
  label: string;
  amountCents: number;
}

export interface BillingTenantOption {
  id: string;
  name: string;
  slug: string;
}

export interface BillingTenantRow {
  id: string;
  name: string;
  slug: string;
  status: string;
  stripeCustomerId: string | null;
  cycleUsageCents: number;
  href: string;
}

export interface BillingRollupStats {
  cycle: BillingCycleWindow;
  totalUsageCents: number;
  tenantsWithUsage: number;
  activeTenantCount: number;
  configuredBillingCount: number;
  missingBillingCount: number;
  categoryTotals: UsageCategoryTotal[];
  tenants: BillingTenantRow[];
  tenantOptions: BillingTenantOption[];
}

export interface TenantBillingStats {
  cycle: BillingCycleWindow;
  tenant: {
    id: string;
    name: string;
    slug: string;
    status: string;
    stripeCustomerId: string | null;
  };
  totalUsageCents: number;
  categoryTotals: UsageCategoryTotal[];
  accountHref: string;
}

interface TenantRow {
  id: string;
  name: string;
  slug: string;
  status: string;
  stripe_customer_id: string | null;
}

interface UsageAggregateRow {
  tenant_id: string;
  category: UsageCategory;
  total_cents: number;
}

export function formatUsdFromCents(cents: number): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(cents / 100);
}

function emptyCategoryTotals(): UsageCategoryTotal[] {
  return USAGE_CATEGORIES.map((category) => ({
    category,
    label: USAGE_CATEGORY_LABELS[category],
    amountCents: 0,
  }));
}

function buildCategoryTotals(
  rows: Array<{ category: UsageCategory; amountCents: number }>,
): UsageCategoryTotal[] {
  const byCategory = new Map<UsageCategory, number>();

  for (const category of USAGE_CATEGORIES) {
    byCategory.set(category, 0);
  }

  for (const row of rows) {
    byCategory.set(row.category, (byCategory.get(row.category) ?? 0) + row.amountCents);
  }

  return USAGE_CATEGORIES.map((category) => ({
    category,
    label: USAGE_CATEGORY_LABELS[category],
    amountCents: byCategory.get(category) ?? 0,
  }));
}

async function fetchUsageAggregates(
  cycle: BillingCycleWindow,
  tenantId?: string,
): Promise<UsageAggregateRow[]> {
  const supabase = await createClient();

  let query = supabase
    .from("usage_events")
    .select("tenant_id, category, billable_amount_cents")
    .gte("occurred_at", cycle.start)
    .lte("occurred_at", cycle.end);

  if (tenantId) {
    query = query.eq("tenant_id", tenantId);
  }

  const { data, error } = await query;

  if (error) {
    if (error.code !== "42P01") {
      console.error("usage_events query failed:", error.message);
    }
    return [];
  }

  const grouped = new Map<string, number>();

  for (const row of data ?? []) {
    const key = `${row.tenant_id}:${row.category}`;
    grouped.set(
      key,
      (grouped.get(key) ?? 0) + Number(row.billable_amount_cents ?? 0),
    );
  }

  return [...grouped.entries()].map(([key, total_cents]) => {
    const [tenant_id, category] = key.split(":");
    return {
      tenant_id,
      category: category as UsageCategory,
      total_cents,
    };
  });
}

export async function fetchBillingRollup(): Promise<BillingRollupStats> {
  const cycle = getCurrentBillingCycle();
  const supabase = await createClient();

  const { data: tenants, error } = await supabase
    .from("tenants")
    .select("id, name, slug, status, stripe_customer_id")
    .order("name", { ascending: true });

  if (error) {
    console.error("billing tenants query failed:", error.message);
    return {
      cycle,
      totalUsageCents: 0,
      tenantsWithUsage: 0,
      activeTenantCount: 0,
      configuredBillingCount: 0,
      missingBillingCount: 0,
      categoryTotals: emptyCategoryTotals(),
      tenants: [],
      tenantOptions: [],
    };
  }

  const rows = (tenants ?? []) as TenantRow[];
  const usageRows = await fetchUsageAggregates(cycle);

  const usageByTenant = new Map<string, number>();
  const categoryAccumulator: Array<{ category: UsageCategory; amountCents: number }> = [];

  for (const usage of usageRows) {
    usageByTenant.set(
      usage.tenant_id,
      (usageByTenant.get(usage.tenant_id) ?? 0) + usage.total_cents,
    );
    categoryAccumulator.push({
      category: usage.category,
      amountCents: usage.total_cents,
    });
  }

  const totalUsageCents = [...usageByTenant.values()].reduce((sum, value) => sum + value, 0);
  const tenantsWithUsage = [...usageByTenant.values()].filter((value) => value > 0).length;

  let activeTenantCount = 0;
  let configuredBillingCount = 0;
  let missingBillingCount = 0;

  const tenantRows: BillingTenantRow[] = rows.map((tenant) => {
    const status = normalizeTenantStatus(tenant.status);
    if (status === "active") activeTenantCount += 1;
    if (tenant.stripe_customer_id) {
      configuredBillingCount += 1;
    } else if (status === "active" || status === "testing") {
      missingBillingCount += 1;
    }

    return {
      id: tenant.id,
      name: tenant.name,
      slug: tenant.slug,
      status: tenant.status,
      stripeCustomerId: tenant.stripe_customer_id,
      cycleUsageCents: usageByTenant.get(tenant.id) ?? 0,
      href: `/admin/billing/tenants/${tenant.id}`,
    };
  });

  tenantRows.sort((a, b) => b.cycleUsageCents - a.cycleUsageCents || a.name.localeCompare(b.name));

  return {
    cycle,
    totalUsageCents,
    tenantsWithUsage,
    activeTenantCount,
    configuredBillingCount,
    missingBillingCount,
    categoryTotals: buildCategoryTotals(categoryAccumulator),
    tenants: tenantRows,
    tenantOptions: rows.map((tenant) => ({
      id: tenant.id,
      name: tenant.name,
      slug: tenant.slug,
    })),
  };
}

export async function fetchTenantBillingStats(
  tenantId: string,
): Promise<TenantBillingStats | null> {
  const cycle = getCurrentBillingCycle();
  const supabase = await createClient();

  const { data: tenant, error } = await supabase
    .from("tenants")
    .select("id, name, slug, status, stripe_customer_id")
    .eq("id", tenantId)
    .maybeSingle();

  if (error || !tenant) {
    if (error) console.error("tenant billing query failed:", error.message);
    return null;
  }

  const usageRows = await fetchUsageAggregates(cycle, tenantId);
  const categoryAccumulator = usageRows.map((row) => ({
    category: row.category,
    amountCents: row.total_cents,
  }));
  const totalUsageCents = categoryAccumulator.reduce((sum, row) => sum + row.amountCents, 0);

  return {
    cycle,
    tenant: {
      id: tenant.id,
      name: tenant.name,
      slug: tenant.slug,
      status: tenant.status,
      stripeCustomerId: tenant.stripe_customer_id,
    },
    totalUsageCents,
    categoryTotals: buildCategoryTotals(categoryAccumulator),
    accountHref: `/admin/accounts/${tenant.id}`,
  };
}

export async function fetchTenantUsageSummary(tenantId: string): Promise<{
  cycle: BillingCycleWindow;
  totalUsageCents: number;
  categoryTotals: UsageCategoryTotal[];
}> {
  const cycle = getCurrentBillingCycle();
  const usageRows = await fetchUsageAggregates(cycle, tenantId);
  const categoryAccumulator = usageRows.map((row) => ({
    category: row.category,
    amountCents: row.total_cents,
  }));

  return {
    cycle,
    totalUsageCents: categoryAccumulator.reduce((sum, row) => sum + row.amountCents, 0),
    categoryTotals: buildCategoryTotals(categoryAccumulator),
  };
}
