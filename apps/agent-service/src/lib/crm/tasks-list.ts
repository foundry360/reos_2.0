import { createClient } from "@/lib/supabase/server";
import type {
  TasksListParams,
  TaskSortColumn,
  TaskStatusFilter,
  TaskViewId,
} from "@/lib/crm/tasks-list-params";
import type { TaskRow } from "@/lib/crm/crm-lists";

export type { TaskRow } from "@/lib/crm/crm-lists";
export { TASK_VIEWS } from "@/lib/crm/tasks-list-params";
export {
  buildTaskSortHref,
  buildTasksListQuery,
  parseTasksListParams,
  PAGE_SIZES,
  type TasksListParams,
  type TaskSortColumn,
  type PageSize,
  type SortDirection,
} from "@/lib/crm/tasks-list-params";

const SELECT_FIELDS = `
  id,
  title,
  status,
  due_at,
  start_at,
  end_at,
  notes,
  contact_id,
  opportunity_id,
  created_at,
  updated_at,
  contacts (
    id,
    first_name,
    last_name,
    record_type
  ),
  opportunities (
    id,
    name
  )
`;

const SELECT_FIELDS_LEGACY = `
  id,
  title,
  status,
  due_at,
  notes,
  contact_id,
  opportunity_id,
  created_at,
  updated_at,
  contacts (
    id,
    first_name,
    last_name,
    record_type
  ),
  opportunities (
    id,
    name
  )
`;

function mapTaskRow(row: {
  id: string;
  title: string;
  status: string;
  due_at: string | null;
  start_at?: string | null;
  end_at?: string | null;
  notes: string | null;
  contact_id: string | null;
  opportunity_id: string | null;
  created_at: string;
  updated_at: string;
  contacts:
    | {
        id: string;
        first_name: string | null;
        last_name: string | null;
        record_type: string | null;
      }
    | {
        id: string;
        first_name: string | null;
        last_name: string | null;
        record_type: string | null;
      }[]
    | null;
  opportunities:
    | { id: string; name: string | null }
    | { id: string; name: string | null }[]
    | null;
}): TaskRow {
  const contact = Array.isArray(row.contacts) ? row.contacts[0] : row.contacts;
  const opportunity = Array.isArray(row.opportunities)
    ? row.opportunities[0]
    : row.opportunities;
  const contactName = contact
    ? [contact.first_name?.trim(), contact.last_name?.trim()].filter(Boolean).join(" ") ||
      null
    : null;
  const recordType =
    contact?.record_type === "contact" || contact?.record_type === "lead"
      ? contact.record_type
      : null;

  return {
    id: row.id,
    title: row.title,
    status: row.status === "done" ? "done" : "open",
    dueAt: row.due_at,
    startAt: row.start_at ?? null,
    endAt: row.end_at ?? null,
    notes: row.notes?.trim() || null,
    contactId: row.contact_id ?? contact?.id ?? null,
    contactName,
    contactRecordType: recordType,
    opportunityId: row.opportunity_id ?? opportunity?.id ?? null,
    opportunityName: opportunity?.name?.trim() || null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function applyTaskSort(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  query: any,
  params: TasksListParams,
) {
  const ascending = params.dir === "asc";
  switch (params.sort as TaskSortColumn) {
    case "title":
      return query.order("title", { ascending });
    case "status":
      return query.order("status", { ascending });
    case "created_at":
      return query.order("created_at", { ascending });
    case "updated_at":
      return query.order("updated_at", { ascending });
    case "start_at":
      return query.order("start_at", { ascending, nullsFirst: false });
    case "end_at":
      return query.order("end_at", { ascending, nullsFirst: false });
    case "due_at":
    default:
      return query.order("due_at", { ascending, nullsFirst: false });
  }
}

function applyTaskViewFilters(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  query: any,
  view: TaskViewId,
  status: TaskStatusFilter = "all",
) {
  const now = new Date();
  switch (view) {
    case "due_soon": {
      // Schedule filters apply to open (Upcoming) work; skip when fetching Completed.
      if (status === "done") return query;
      const inSevenDays = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000).toISOString();
      return query
        .not("due_at", "is", null)
        .gte("due_at", now.toISOString())
        .lte("due_at", inSevenDays);
    }
    case "overdue":
      if (status === "done") return query;
      return query
        .not("due_at", "is", null)
        .lt("due_at", now.toISOString());
    case "recently_modified": {
      const since = new Date(now.getTime() - 14 * 24 * 60 * 60 * 1000).toISOString();
      return query.gte("updated_at", since);
    }
    default:
      return query;
  }
}

export interface TasksListResult {
  rows: TaskRow[];
  total: number;
  params: TasksListParams;
}

export async function fetchTasksListPaged(
  tenantId: string,
  params: TasksListParams,
  options?: { forExport?: boolean },
): Promise<TasksListResult> {
  const supabase = await createClient();

  async function run(selectFields: string) {
    let query = supabase
      .from("tasks")
      .select(selectFields, { count: "exact" })
      .eq("tenant_id", tenantId);

    if (params.q) {
      const term = params.q.replace(/[%_,]/g, "").trim();
      if (term) {
        query = query.ilike("title", `%${term}%`);
      }
    }

    if (params.status !== "all") {
      query = query.eq("status", params.status);
    }

    query = applyTaskViewFilters(query, params.view, params.status);
    query = applyTaskSort(query, params);

    if (options?.forExport) {
      return query.limit(5000);
    }

    const from = (params.page - 1) * params.perPage;
    const to = from + params.perPage - 1;
    return query.range(from, to);
  }

  let { data, count, error } = await run(SELECT_FIELDS);

  if (error && /Could not find the '(start_at|end_at)' column|column ["']?(start_at|end_at)["']?.*(does not exist|not found)|schema cache.*\b(start_at|end_at)\b/i.test(error.message)) {
    ({ data, count, error } = await run(SELECT_FIELDS_LEGACY));
  }

  if (error) {
    console.error(
      options?.forExport ? "tasks export failed:" : "tasks list failed:",
      error.message,
    );
    return { rows: [], total: 0, params };
  }

  return {
    rows: (data ?? []).map((row) =>
      mapTaskRow(row as unknown as Parameters<typeof mapTaskRow>[0]),
    ),
    total: count ?? 0,
    params,
  };
}

function csvEscape(value: string): string {
  if (/[",\n\r]/.test(value)) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

export function tasksToCsv(rows: TaskRow[]): string {
  const header = [
    "Title",
    "Status",
    "Start",
    "End",
    "Due",
    "Client",
    "Opportunity",
    "Notes",
    "Created",
    "Updated",
  ];
  const lines = [header.join(",")];
  for (const row of rows) {
    lines.push(
      [
        csvEscape(row.title),
        csvEscape(row.status === "done" ? "Done" : "Open"),
        csvEscape(row.startAt ?? ""),
        csvEscape(row.endAt ?? ""),
        csvEscape(row.dueAt ?? ""),
        csvEscape(row.contactName ?? ""),
        csvEscape(row.opportunityName ?? ""),
        csvEscape(row.notes ?? ""),
        csvEscape(row.createdAt),
        csvEscape(row.updatedAt),
      ].join(","),
    );
  }
  return `${lines.join("\n")}\n`;
}
