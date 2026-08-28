export const USER_SORT_COLUMNS = ["name", "account", "role", "created_at"] as const;

export type UserSortColumn = (typeof USER_SORT_COLUMNS)[number];
export type SortDirection = "asc" | "desc";
export const PAGE_SIZES = [25, 50, 75, 100] as const;
export type PageSize = (typeof PAGE_SIZES)[number];
export type UsersLayout = "list" | "kanban";

export interface UsersListParams {
  q: string;
  role: "all" | "owner" | "agent" | "viewer";
  layout: UsersLayout;
  sort: UserSortColumn;
  dir: SortDirection;
  page: number;
  perPage: PageSize;
}

function readParam(value: string | string[] | undefined): string {
  return typeof value === "string" ? value : "";
}

export function parseUsersListParams(
  searchParams: Record<string, string | string[] | undefined>,
): UsersListParams {
  const sortRaw = readParam(searchParams.sort);
  const sort = USER_SORT_COLUMNS.includes(sortRaw as UserSortColumn)
    ? (sortRaw as UserSortColumn)
    : "created_at";

  const dirRaw = readParam(searchParams.dir);
  const dir: SortDirection = dirRaw === "asc" ? "asc" : "desc";

  const roleRaw = readParam(searchParams.role);
  const role =
    roleRaw === "owner" || roleRaw === "agent" || roleRaw === "viewer" ? roleRaw : "all";

  const layoutRaw = readParam(searchParams.layout);
  const layout: UsersLayout = layoutRaw === "kanban" ? "kanban" : "list";

  const perPageRaw = Number(readParam(searchParams.perPage));
  const perPage = PAGE_SIZES.includes(perPageRaw as PageSize)
    ? (perPageRaw as PageSize)
    : 25;

  const pageRaw = Number(readParam(searchParams.page));
  const page = Number.isFinite(pageRaw) && pageRaw > 0 ? Math.floor(pageRaw) : 1;

  return {
    q: readParam(searchParams.q).trim(),
    role,
    layout,
    sort,
    dir,
    page,
    perPage,
  };
}

export function buildUsersListQuery(params: UsersListParams): string {
  const qs = new URLSearchParams();
  if (params.q) qs.set("q", params.q);
  if (params.role !== "all") qs.set("role", params.role);
  if (params.layout === "kanban") qs.set("layout", "kanban");
  if (params.sort !== "created_at") qs.set("sort", params.sort);
  if (params.dir !== "desc") qs.set("dir", params.dir);
  if (params.page !== 1) qs.set("page", String(params.page));
  if (params.perPage !== 25) qs.set("perPage", String(params.perPage));
  const str = qs.toString();
  return str ? `?${str}` : "";
}

export function buildSortHref(params: UsersListParams, column: UserSortColumn): string {
  const nextDir: SortDirection =
    params.sort === column && params.dir === "asc" ? "desc" : "asc";

  return buildUsersListQuery({
    ...params,
    sort: column,
    dir: nextDir,
    page: 1,
  });
}
