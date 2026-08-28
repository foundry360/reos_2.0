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
  email: string | null;
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

export interface ActiveKanbanResult {
  columns: { active: AccountRow[]; paused: AccountRow[] };
  total: number;
}

async function fetchAccountRows(
  statuses: string[],
  q: string,
): Promise<AccountRow[]> {
  const supabase = await createClient();

  let query = supabase
    .from("tenants")
    .select("id, name, slug, status, timezone, created_at, email")
    .in("status", statuses)
    .order("name", { ascending: true });

  if (q) {
    const term = q.replace(/[%_,]/g, "");
    if (term) {
      query = query.or(`name.ilike.%${term}%,slug.ilike.%${term}%`);
    }
  }

  const { data: tenants, error } = await query.limit(500);

  if (error) {
    console.error("accounts kanban query failed:", error.message);
    return [];
  }

  const phoneByTenant = await attachPhones(tenants ?? []);
  return (tenants ?? []).map((tenant) => ({
    ...tenant,
    phone: phoneByTenant.get(tenant.id) ?? null,
    email: tenant.email ?? null,
  }));
}

export async function fetchActiveKanbanAccounts(
  q: string,
  status: AccountsListParams["status"],
): Promise<ActiveKanbanResult> {
  const statuses =
    status === "all" ? (["active", "paused"] as const) : ([status] as const);
  const rows = await fetchAccountRows([...statuses], q);

  const columns = {
    active: rows.filter((row) => row.status === "active"),
    paused: rows.filter((row) => row.status === "paused"),
  };

  return { columns, total: rows.length };
}

export async function fetchOnboardingKanbanAccounts(q: string): Promise<OnboardingKanbanResult> {
  const rows = await fetchAccountRows([...ONBOARDING_STATUSES], q);

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

export async function fetchAccountsList(
  params: AccountsListParams,
  options?: { forExport?: boolean },
): Promise<AccountsListResult> {
  const supabase = await createClient();

  let query = supabase
    .from("tenants")
    .select("id, name, slug, status, timezone, created_at, email", { count: "exact" });

  if (params.q) {
    const term = params.q.replace(/[%_,]/g, "");
    if (term) {
      query = query.or(`name.ilike.%${term}%,slug.ilike.%${term}%`);
    }
  }

  if (params.view === "active") {
    if (params.status === "all") {
      query = query.in("status", ["active", "paused"]);
    } else {
      query = query.eq("status", params.status);
    }
  } else if (params.view === "onboarding") {
    if (params.status !== "all") {
      query = query.eq("status", params.status);
    } else {
      query = query.in("status", [...ONBOARDING_STATUSES]);
    }
  } else if (params.status !== "all") {
    query = query.eq("status", params.status);
  }

  if (options?.forExport) {
    const { data, count, error } = await query.limit(5000);
    if (error) {
      console.error("accounts export query failed:", error.message);
      return { rows: [], total: 0, params };
    }
    const phoneByTenant = await attachPhones(data ?? []);
    const rows: AccountRow[] = (data ?? []).map((tenant) => ({
      ...tenant,
      phone: phoneByTenant.get(tenant.id) ?? null,
      email: tenant.email ?? null,
    }));
    return { rows, total: count ?? rows.length, params };
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
    email: tenant.email ?? null,
  }));

  return {
    rows,
    total: count ?? 0,
    params,
  };
}

function csvEscape(value: string): string {
  if (/[",\n]/.test(value)) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

export function accountsToCsv(rows: AccountRow[]): string {
  const header = ["Name", "Account Name", "Status", "Phone", "Email", "Timezone", "Created At"];
  const lines = [header.join(",")];
  for (const row of rows) {
    lines.push(
      [
        csvEscape(row.name),
        csvEscape(row.slug),
        csvEscape(row.status),
        csvEscape(row.phone ?? ""),
        csvEscape(row.email ?? ""),
        csvEscape(row.timezone),
        csvEscape(row.created_at),
      ].join(","),
    );
  }
  return `${lines.join("\n")}\n`;
}
