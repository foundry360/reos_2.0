import { TENANT_STATUS_VALUES, type TenantStatus } from "@/lib/admin/account-status";

export const ACCOUNT_SORT_COLUMNS = [
  "name",
  "slug",
  "status",
  "timezone",
  "created_at",
] as const;

export type AccountSortColumn = (typeof ACCOUNT_SORT_COLUMNS)[number];
export type SortDirection = "asc" | "desc";

export const PAGE_SIZES = [25, 50, 75, 100] as const;
export type PageSize = (typeof PAGE_SIZES)[number];

export type AccountsView = "active" | "onboarding";
export type AccountsLayout = "list" | "kanban";

export function defaultAccountsLayout(view: AccountsView): AccountsLayout {
  return view === "onboarding" ? "kanban" : "list";
}

export interface AccountsListParams {
  q: string;
  view: AccountsView;
  layout: AccountsLayout;
  status: "all" | TenantStatus;
  sort: AccountSortColumn;
  dir: SortDirection;
  page: number;
  perPage: PageSize;
}

function readParam(value: string | string[] | undefined): string {
  return typeof value === "string" ? value : "";
}

export function parseAccountsListParams(
  searchParams: Record<string, string | string[] | undefined>,
): AccountsListParams {
  const sortRaw = readParam(searchParams.sort);
  const sort = ACCOUNT_SORT_COLUMNS.includes(sortRaw as AccountSortColumn)
    ? (sortRaw as AccountSortColumn)
    : "created_at";

  const dirRaw = readParam(searchParams.dir);
  const dir: SortDirection = dirRaw === "asc" ? "asc" : "desc";

  const statusRaw = readParam(searchParams.status);
  const status =
    statusRaw === "all" || TENANT_STATUS_VALUES.includes(statusRaw as TenantStatus)
      ? (statusRaw === "all" ? "all" : (statusRaw as TenantStatus))
      : statusRaw === "pending"
        ? "company_info"
        : "all";

  const perPageRaw = Number(readParam(searchParams.perPage));
  const perPage = PAGE_SIZES.includes(perPageRaw as PageSize)
    ? (perPageRaw as PageSize)
    : 25;

  const pageRaw = Number(readParam(searchParams.page));
  const page = Number.isFinite(pageRaw) && pageRaw > 0 ? Math.floor(pageRaw) : 1;

  const viewRaw = readParam(searchParams.view);
  const view: AccountsView = viewRaw === "onboarding" ? "onboarding" : "active";

  const layoutRaw = readParam(searchParams.layout);
  const layout: AccountsLayout =
    layoutRaw === "kanban" || layoutRaw === "list"
      ? layoutRaw
      : defaultAccountsLayout(view);

  return {
    q: readParam(searchParams.q).trim(),
    view,
    layout,
    status,
    sort,
    dir,
    page,
    perPage,
  };
}

export function buildAccountsListQuery(params: AccountsListParams): string {
  const qs = new URLSearchParams();
  if (params.q) qs.set("q", params.q);
  if (params.view !== "active") qs.set("view", params.view);
  if (params.layout !== defaultAccountsLayout(params.view)) {
    qs.set("layout", params.layout);
  }
  if (params.status !== "all") qs.set("status", params.status);
  if (params.sort !== "created_at") qs.set("sort", params.sort);
  if (params.dir !== "desc") qs.set("dir", params.dir);
  if (params.page !== 1) qs.set("page", String(params.page));
  if (params.perPage !== 25) qs.set("perPage", String(params.perPage));
  const str = qs.toString();
  return str ? `?${str}` : "";
}

export function buildSortHref(
  params: AccountsListParams,
  column: AccountSortColumn,
): string {
  const nextDir: SortDirection =
    params.sort === column && params.dir === "asc" ? "desc" : "asc";

  return buildAccountsListQuery({
    ...params,
    sort: column,
    dir: nextDir,
    page: 1,
  });
}
