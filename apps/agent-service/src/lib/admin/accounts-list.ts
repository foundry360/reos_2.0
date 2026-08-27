import { ONBOARDING_STATUSES, type OnboardingStatus } from "@/lib/admin/account-status";
import type { AccountsListParams } from "@/lib/admin/accounts-list-params";
import { createClient } from "@/lib/supabase/server";

export type {
  AccountSortColumn,
  AccountsListParams,
  PageSize,
  SortDirection,
} from "@/lib/admin/accounts-list-params";
export {
  ACCOUNT_SORT_COLUMNS,
  PAGE_SIZES,
  buildAccountsListQuery,
  buildSortHref,
  parseAccountsListParams,
} from "@/lib/admin/accounts-list-params";

export interface AccountRow {
  id: string;
  name: string;
  slug: string;
  status: string;
  timezone: string;
  created_at: string;
  phone: string | null;
}

export interface AccountsListResult {
  rows: AccountRow[];
  total: number;
  params: AccountsListParams;
}

export interface OnboardingKanbanResult {
  columns: Record<OnboardingStatus, AccountRow[]>;
  total: number;
}

async function attachPhones(rows: { id: string }[]): Promise<Map<string, string | null>> {
  const supabase = await createClient();
  const tenantIds = rows.map((row) => row.id);
  const { data: phones } =
    tenantIds.length > 0
      ? await supabase
          .from("tenant_phone_numbers")
          .select("tenant_id, phone_e164")
          .in("tenant_id", tenantIds)
          .eq("is_primary", true)
      : { data: [] };

  return new Map((phones ?? []).map((p) => [p.tenant_id, p.phone_e164]));
}

export async function fetchOnboardingKanbanAccounts(q: string): Promise<OnboardingKanbanResult> {
  const supabase = await createClient();

  let query = supabase
    .from("tenants")
    .select("id, name, slug, status, timezone, created_at")
    .in("status", [...ONBOARDING_STATUSES])
    .order("name", { ascending: true });

  if (q) {
    const term = q.replace(/[%_,]/g, "");
    if (term) {
      query = query.or(`name.ilike.%${term}%,slug.ilike.%${term}%`);
    }
  }

  const { data: tenants, error } = await query.limit(500);

  if (error) {
    console.error("onboarding kanban query failed:", error.message);
    return {
      columns: {
        company_info: [],
        billing: [],
        agents: [],
        connected_accounts: [],
        testing: [],
      },
      total: 0,
    };
  }

  const phoneByTenant = await attachPhones(tenants ?? []);
  const rows: AccountRow[] = (tenants ?? []).map((tenant) => ({
    ...tenant,
    phone: phoneByTenant.get(tenant.id) ?? null,
  }));

  const columns = ONBOARDING_STATUSES.reduce(
    (acc, status) => {
      acc[status] = rows.filter((row) => row.status === status);
      return acc;
    },
    {
      company_info: [],
      billing: [],
      agents: [],
      connected_accounts: [],
      testing: [],
    } as Record<OnboardingStatus, AccountRow[]>,
  );

  return { columns, total: rows.length };
}

export async function fetchAccountsList(
  params: AccountsListParams,
): Promise<AccountsListResult> {
  const supabase = await createClient();

  let query = supabase
    .from("tenants")
    .select("id, name, slug, status, timezone, created_at", { count: "exact" });

  if (params.q) {
    const term = params.q.replace(/[%_,]/g, "");
    if (term) {
      query = query.or(`name.ilike.%${term}%,slug.ilike.%${term}%`);
    }
  }

  if (params.view === "active") {
    query = query.eq("status", "active");
  } else if (params.status !== "all") {
    query = query.eq("status", params.status);
  }

  const from = (params.page - 1) * params.perPage;
  const to = from + params.perPage - 1;

  const { data: tenants, count, error } = await query
    .order(params.sort, { ascending: params.dir === "asc" })
    .range(from, to);

  if (error) {
    console.error("accounts list query failed:", error.message);
    return { rows: [], total: 0, params };
  }

  const tenantIds = tenants?.map((t) => t.id) ?? [];
  const phoneByTenant = await attachPhones(tenants ?? []);

  const rows: AccountRow[] = (tenants ?? []).map((tenant) => ({
    ...tenant,
    phone: phoneByTenant.get(tenant.id) ?? null,
  }));

  return {
    rows,
    total: count ?? 0,
    params,
  };
}
