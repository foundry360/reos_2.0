import {
  DEFAULT_OPPORTUNITY_PIPELINE,
  isOpportunityPipeline,
  isOpportunityStage,
  type OpportunityPipeline,
  type OpportunityStage,
} from "@/lib/opportunities/opportunity-stages";

export const OPPORTUNITY_SORT_COLUMNS = [
  "name",
  "stage",
  "amount",
  "expected_close_date",
  "updated_at",
  "created_at",
] as const;

export type OpportunitySortColumn = (typeof OPPORTUNITY_SORT_COLUMNS)[number];
export type SortDirection = "asc" | "desc";
export const PAGE_SIZES = [25, 50, 75, 100] as const;
export type PageSize = (typeof PAGE_SIZES)[number];
export type OpportunitiesLayout = "list" | "kanban";

export type OpportunityViewId =
  | "all"
  | "new"
  | "ai_qualifying"
  | "qualified"
  | "appointment_set"
  | "nurture"
  | "closed_won"
  | "recently_modified";

export type OpportunityStageFilter = "all" | OpportunityStage;

export interface OpportunitiesListParams {
  q: string;
  stage: OpportunityStageFilter;
  view: OpportunityViewId;
  pipeline: OpportunityPipeline;
  layout: OpportunitiesLayout;
  sort: OpportunitySortColumn;
  dir: SortDirection;
  page: number;
  perPage: PageSize;
}

const VIEW_IDS: OpportunityViewId[] = [
  "all",
  "new",
  "ai_qualifying",
  "qualified",
  "appointment_set",
  "nurture",
  "closed_won",
  "recently_modified",
];

export function isOpportunityViewId(value: string): value is OpportunityViewId {
  return VIEW_IDS.includes(value as OpportunityViewId);
}

function readParam(value: string | string[] | undefined): string {
  return typeof value === "string" ? value : "";
}

export function parseOpportunitiesListParams(
  searchParams: Record<string, string | string[] | undefined>,
): OpportunitiesListParams {
  const sortRaw = readParam(searchParams.sort);
  const sort = OPPORTUNITY_SORT_COLUMNS.includes(sortRaw as OpportunitySortColumn)
    ? (sortRaw as OpportunitySortColumn)
    : "updated_at";

  const dirRaw = readParam(searchParams.dir);
  const dir: SortDirection = dirRaw === "asc" ? "asc" : "desc";

  const stageRaw = readParam(searchParams.stage);
  const stage: OpportunityStageFilter = isOpportunityStage(stageRaw) ? stageRaw : "all";

  const viewRaw = readParam(searchParams.view);
  const view: OpportunityViewId = isOpportunityViewId(viewRaw) ? viewRaw : "all";

  const pipelineRaw = readParam(searchParams.pipeline);
  const pipeline: OpportunityPipeline = isOpportunityPipeline(pipelineRaw)
    ? pipelineRaw
    : DEFAULT_OPPORTUNITY_PIPELINE;

  const layoutRaw = readParam(searchParams.layout);
  const layout: OpportunitiesLayout = layoutRaw === "list" ? "list" : "kanban";

  const perPageRaw = Number(readParam(searchParams.perPage));
  const perPage = PAGE_SIZES.includes(perPageRaw as PageSize)
    ? (perPageRaw as PageSize)
    : 25;

  const pageRaw = Number(readParam(searchParams.page));
  const page = Number.isFinite(pageRaw) && pageRaw > 0 ? Math.floor(pageRaw) : 1;

  return {
    q: readParam(searchParams.q).trim(),
    stage,
    view,
    pipeline,
    layout,
    sort,
    dir,
    page,
    perPage,
  };
}

export function buildOpportunitiesListQuery(params: OpportunitiesListParams): string {
  const qs = new URLSearchParams();
  if (params.view !== "all") qs.set("view", params.view);
  if (params.pipeline !== DEFAULT_OPPORTUNITY_PIPELINE) qs.set("pipeline", params.pipeline);
  if (params.layout !== "kanban") qs.set("layout", params.layout);
  if (params.q) qs.set("q", params.q);
  if (params.stage !== "all") qs.set("stage", params.stage);
  if (params.sort !== "updated_at") qs.set("sort", params.sort);
  if (params.dir !== "desc") qs.set("dir", params.dir);
  if (params.page !== 1) qs.set("page", String(params.page));
  if (params.perPage !== 25) qs.set("perPage", String(params.perPage));
  const str = qs.toString();
  return str ? `?${str}` : "";
}

export function buildOpportunitySortHref(
  params: OpportunitiesListParams,
  column: OpportunitySortColumn,
): string {
  const nextDir: SortDirection =
    params.sort === column && params.dir === "asc" ? "desc" : "asc";

  return `/opportunities${buildOpportunitiesListQuery({
    ...params,
    sort: column,
    dir: nextDir,
    page: 1,
  })}`;
}
