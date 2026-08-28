import { isLeadStatus } from "@/lib/leads/lead-status";
import type { LeadStatus } from "@/lib/coordinator";
import { isLeadViewId, type LeadViewId } from "@/lib/leads/leads-views";

export const LEAD_SORT_COLUMNS = [
  "name",
  "status",
  "score",
  "temperature",
  "updated_at",
  "created_at",
] as const;

export type LeadSortColumn = (typeof LEAD_SORT_COLUMNS)[number];
export type SortDirection = "asc" | "desc";
export const PAGE_SIZES = [25, 50, 75, 100] as const;
export type PageSize = (typeof PAGE_SIZES)[number];
export type LeadsLayout = "list" | "kanban";

export type LeadStatusFilter = "all" | LeadStatus;

export interface LeadsListParams {
  q: string;
  status: LeadStatusFilter;
  view: LeadViewId;
  layout: LeadsLayout;
  sort: LeadSortColumn;
  dir: SortDirection;
  page: number;
  perPage: PageSize;
}

function readParam(value: string | string[] | undefined): string {
  return typeof value === "string" ? value : "";
}

export function parseLeadsListParams(
  searchParams: Record<string, string | string[] | undefined>,
): LeadsListParams {
  const sortRaw = readParam(searchParams.sort);
  const sort = LEAD_SORT_COLUMNS.includes(sortRaw as LeadSortColumn)
    ? (sortRaw as LeadSortColumn)
    : "updated_at";

  const dirRaw = readParam(searchParams.dir);
  const dir: SortDirection = dirRaw === "asc" ? "asc" : "desc";

  const statusRaw = readParam(searchParams.status);
  const status: LeadStatusFilter = isLeadStatus(statusRaw) ? statusRaw : "all";

  const viewRaw = readParam(searchParams.view);
  const view: LeadViewId = isLeadViewId(viewRaw) ? viewRaw : "all";

  const layoutRaw = readParam(searchParams.layout);
  const layout: LeadsLayout = layoutRaw === "kanban" ? "kanban" : "list";

  const perPageRaw = Number(readParam(searchParams.perPage));
  const perPage = PAGE_SIZES.includes(perPageRaw as PageSize)
    ? (perPageRaw as PageSize)
    : 25;

  const pageRaw = Number(readParam(searchParams.page));
  const page = Number.isFinite(pageRaw) && pageRaw > 0 ? Math.floor(pageRaw) : 1;

  return {
    q: readParam(searchParams.q).trim(),
    status,
    view,
    layout,
    sort,
    dir,
    page,
    perPage,
  };
}

export function buildLeadsListQuery(params: LeadsListParams): string {
  const qs = new URLSearchParams();
  if (params.view !== "all") qs.set("view", params.view);
  if (params.layout !== "list") qs.set("layout", params.layout);
  if (params.q) qs.set("q", params.q);
  if (params.status !== "all") qs.set("status", params.status);
  if (params.sort !== "updated_at") qs.set("sort", params.sort);
  if (params.dir !== "desc") qs.set("dir", params.dir);
  if (params.page !== 1) qs.set("page", String(params.page));
  if (params.perPage !== 25) qs.set("perPage", String(params.perPage));
  const str = qs.toString();
  return str ? `?${str}` : "";
}

export function buildSortHref(
  params: LeadsListParams,
  column: LeadSortColumn,
  basePath = "/leads",
): string {
  const nextDir: SortDirection =
    params.sort === column && params.dir === "asc" ? "desc" : "asc";

  return `${basePath}${buildLeadsListQuery({
    ...params,
    sort: column,
    dir: nextDir,
    page: 1,
  })}`;
}
