import { createClient } from "@/lib/supabase/server";
import type { AccountsListParams } from "@/lib/admin/accounts-list-params";

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

  if (params.status !== "all") {
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
  const { data: phones } =
    tenantIds.length > 0
      ? await supabase
          .from("tenant_phone_numbers")
          .select("tenant_id, phone_e164")
          .in("tenant_id", tenantIds)
          .eq("is_primary", true)
      : { data: [] };

  const phoneByTenant = new Map(
    (phones ?? []).map((p) => [p.tenant_id, p.phone_e164]),
  );

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
