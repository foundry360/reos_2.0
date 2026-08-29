export const TASK_SORT_COLUMNS = [
  "title",
  "status",
  "start_at",
  "end_at",
  "due_at",
  "updated_at",
  "created_at",
] as const;

export type TaskSortColumn = (typeof TASK_SORT_COLUMNS)[number];
export type SortDirection = "asc" | "desc";
export const PAGE_SIZES = [25, 50, 75, 100] as const;
export type PageSize = (typeof PAGE_SIZES)[number];

/** Filters that work with Upcoming + Completed split tables. */
export type TaskViewId =
  | "all"
  | "due_soon"
  | "overdue"
  | "recently_modified";

/** @deprecated Prefer section split; kept for query/internal fetches. */
export type TaskStatusFilter = "all" | "open" | "done";

export interface TasksListParams {
  q: string;
  status: TaskStatusFilter;
  view: TaskViewId;
  sort: TaskSortColumn;
  dir: SortDirection;
  page: number;
  /** Pagination for the Completed table when both sections are shown. */
  cpage: number;
  perPage: PageSize;
}

const VIEW_IDS: TaskViewId[] = [
  "all",
  "due_soon",
  "overdue",
  "recently_modified",
];

export function isTaskViewId(value: string): value is TaskViewId {
  return VIEW_IDS.includes(value as TaskViewId);
}

function readParam(value: string | string[] | undefined): string {
  return typeof value === "string" ? value : "";
}

export function parseTasksListParams(
  searchParams: Record<string, string | string[] | undefined>,
): TasksListParams {
  const sortRaw = readParam(searchParams.sort);
  const sort = TASK_SORT_COLUMNS.includes(sortRaw as TaskSortColumn)
    ? (sortRaw as TaskSortColumn)
    : "due_at";

  const dirRaw = readParam(searchParams.dir);
  const dir: SortDirection =
    dirRaw === "desc" ? "desc" : dirRaw === "asc" ? "asc" : sort === "due_at" ? "asc" : "desc";

  // Legacy open/done view URLs map to all — status is represented by Upcoming/Completed sections.
  const viewRaw = readParam(searchParams.view);
  const view: TaskViewId =
    viewRaw === "open" || viewRaw === "done"
      ? "all"
      : isTaskViewId(viewRaw)
        ? viewRaw
        : "all";

  const perPageRaw = Number(readParam(searchParams.perPage));
  const perPage = PAGE_SIZES.includes(perPageRaw as PageSize)
    ? (perPageRaw as PageSize)
    : 25;

  const pageRaw = Number(readParam(searchParams.page));
  const page = Number.isFinite(pageRaw) && pageRaw > 0 ? Math.floor(pageRaw) : 1;

  const cpageRaw = Number(readParam(searchParams.cpage));
  const cpage = Number.isFinite(cpageRaw) && cpageRaw > 0 ? Math.floor(cpageRaw) : 1;

  return {
    q: readParam(searchParams.q).trim(),
    status: "all",
    view,
    sort,
    dir,
    page,
    cpage,
    perPage,
  };
}

export function buildTasksListQuery(params: TasksListParams): string {
  const qs = new URLSearchParams();
  if (params.view !== "all") qs.set("view", params.view);
  if (params.q) qs.set("q", params.q);
  if (params.sort !== "due_at") qs.set("sort", params.sort);
  const defaultDir: SortDirection = params.sort === "due_at" ? "asc" : "desc";
  if (params.dir !== defaultDir) qs.set("dir", params.dir);
  if (params.page !== 1) qs.set("page", String(params.page));
  if (params.cpage !== 1) qs.set("cpage", String(params.cpage));
  if (params.perPage !== 25) qs.set("perPage", String(params.perPage));
  const str = qs.toString();
  return str ? `?${str}` : "";
}

export function buildTaskSortHref(params: TasksListParams, column: TaskSortColumn): string {
  const nextDir: SortDirection =
    params.sort === column && params.dir === "asc" ? "desc" : "asc";

  return `/tasks${buildTasksListQuery({
    ...params,
    sort: column,
    dir: nextDir,
    page: 1,
    cpage: 1,
  })}`;
}

/** Schedule filters (due soon / overdue) only apply to Upcoming. */
export function tasksListSections(
  params: TasksListParams,
): Array<"upcoming" | "completed"> {
  if (params.view === "due_soon" || params.view === "overdue") {
    return ["upcoming"];
  }
  return ["upcoming", "completed"];
}

export const TASK_VIEWS: { id: TaskViewId; label: string; hint?: string }[] = [
  { id: "all", label: "All tasks" },
  { id: "due_soon", label: "Due soon", hint: "Upcoming due in the next 7 days" },
  { id: "overdue", label: "Overdue", hint: "Upcoming past due" },
  {
    id: "recently_modified",
    label: "Recently modified",
    hint: "Updated in the last 14 days",
  },
];
