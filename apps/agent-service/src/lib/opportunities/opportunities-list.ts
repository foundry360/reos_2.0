import { createClient } from "@/lib/supabase/server";
import {
  DEFAULT_OPPORTUNITY_TYPE,
  isOpportunityLeadSource,
  isOpportunityPriority,
  isOpportunityType,
  type OpportunityType,
} from "@/lib/opportunities/opportunity-fields";
import {
  DEFAULT_OPPORTUNITY_PIPELINE,
  DEFAULT_OPPORTUNITY_STAGE,
  formatOpportunityStageLabel,
  INTAKE_STAGE_OPTIONS,
  isOpportunityPipeline,
  isOpportunityStage,
  type OpportunityPipeline,
  type OpportunityStage,
} from "@/lib/opportunities/opportunity-stages";
import type {
  OpportunitiesListParams,
  OpportunityViewId,
} from "@/lib/opportunities/opportunities-list-params";
import type { OpportunityRow } from "@/lib/opportunities/opportunities-types";

export type { OpportunityRow } from "@/lib/opportunities/opportunities-types";
export {
  buildOpportunitiesListQuery,
  buildOpportunitySortHref,
  parseOpportunitiesListParams,
  PAGE_SIZES,
  type OpportunitiesListParams,
  type OpportunitySortColumn,
  type PageSize,
  type SortDirection,
} from "@/lib/opportunities/opportunities-list-params";

const SELECT_FIELDS = `
  id,
  name,
  pipeline,
  stage,
  opportunity_type,
  lead_source,
  priority,
  assigned_agent_id,
  amount_cents,
  expected_close_date,
  notes,
  contact_id,
  created_at,
  updated_at,
  contacts (
    first_name,
    last_name,
    record_type
  )
`;

function emptyStageColumns(): Record<OpportunityStage, OpportunityRow[]> {
  return INTAKE_STAGE_OPTIONS.reduce(
    (acc, stage) => {
      acc[stage.value] = [];
      return acc;
    },
    {} as Record<OpportunityStage, OpportunityRow[]>,
  );
}

function mapOpportunityRow(row: {
  id: string;
  name: string;
  pipeline: string | null;
  stage: string;
  opportunity_type: string | null;
  lead_source: string | null;
  priority: string | null;
  assigned_agent_id: string | null;
  amount_cents: number | null;
  expected_close_date: string | null;
  notes: string | null;
  contact_id: string | null;
  created_at: string;
  updated_at: string;
  contacts:
    | {
        first_name: string | null;
        last_name: string | null;
        record_type: string | null;
      }
    | {
        first_name: string | null;
        last_name: string | null;
        record_type: string | null;
      }[]
    | null;
}): OpportunityRow {
  const contact = Array.isArray(row.contacts) ? row.contacts[0] : row.contacts;
  const contactName = contact
    ? [contact.first_name?.trim(), contact.last_name?.trim()].filter(Boolean).join(" ") ||
      null
    : null;
  const stage = isOpportunityStage(row.stage) ? row.stage : DEFAULT_OPPORTUNITY_STAGE;
  const pipeline: OpportunityPipeline = isOpportunityPipeline(row.pipeline ?? "")
    ? (row.pipeline as OpportunityPipeline)
    : DEFAULT_OPPORTUNITY_PIPELINE;
  const typeRaw = row.opportunity_type ?? "";
  const opportunityType: OpportunityType = isOpportunityType(typeRaw)
    ? typeRaw
    : DEFAULT_OPPORTUNITY_TYPE;
  const leadSourceRaw = row.lead_source ?? "";
  const priorityRaw = row.priority ?? "";

  return {
    id: row.id,
    name: row.name,
    pipeline,
    stage,
    stageLabel: formatOpportunityStageLabel(stage),
    opportunityType,
    leadSource: isOpportunityLeadSource(leadSourceRaw) ? leadSourceRaw : null,
    priority: isOpportunityPriority(priorityRaw) ? priorityRaw : null,
    assignedAgentId: row.assigned_agent_id,
    amountCents: row.amount_cents,
    expectedCloseDate: row.expected_close_date,
    contactId: row.contact_id,
    contactName,
    contactRecordType:
      contact?.record_type === "contact"
        ? "contact"
        : contact?.record_type === "lead"
          ? "lead"
          : null,
    notes: row.notes,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function viewToStage(view: OpportunityViewId): OpportunityStage | null {
  switch (view) {
    case "new":
      return "New";
    case "ai_qualifying":
      return "AI_Qualifying";
    case "qualified":
      return "Qualified";
    case "appointment_set":
      return "Appointment_Set";
    case "nurture":
      return "Nurture";
    case "closed_won":
      return "Closed_Won";
    default:
      return null;
  }
}

function applyOpportunitySort(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  query: any,
  params: OpportunitiesListParams,
) {
  const ascending = params.dir === "asc";
  switch (params.sort) {
    case "name":
      return query.order("name", { ascending });
    case "stage":
      return query.order("stage", { ascending });
    case "amount":
      return query.order("amount_cents", { ascending, nullsFirst: false });
    case "expected_close_date":
      return query.order("expected_close_date", { ascending, nullsFirst: false });
    case "created_at":
      return query.order("created_at", { ascending });
    case "updated_at":
    default:
      return query.order("updated_at", { ascending });
  }
}

export interface OpportunitiesListResult {
  rows: OpportunityRow[];
  total: number;
  params: OpportunitiesListParams;
}

export async function fetchOpportunityById(
  tenantId: string,
  opportunityId: string,
): Promise<OpportunityRow | null> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("opportunities")
    .select(SELECT_FIELDS)
    .eq("tenant_id", tenantId)
    .eq("id", opportunityId)
    .maybeSingle();

  if (error) {
    console.error("opportunity detail failed:", error.message);
    return null;
  }
  if (!data) return null;
  return mapOpportunityRow(data);
}

export async function fetchOpportunitiesList(
  tenantId: string,
  params: OpportunitiesListParams,
  options?: { forExport?: boolean; pipeline?: OpportunityPipeline },
): Promise<OpportunitiesListResult> {
  const pipeline = options?.pipeline ?? params.pipeline ?? DEFAULT_OPPORTUNITY_PIPELINE;
  const supabase = await createClient();

  let query = supabase
    .from("opportunities")
    .select(SELECT_FIELDS, { count: "exact" })
    .eq("tenant_id", tenantId)
    .eq("pipeline", pipeline);

  if (params.q) {
    const term = params.q.replace(/[%_,]/g, "").trim();
    if (term) {
      query = query.ilike("name", `%${term}%`);
    }
  }

  if (params.stage !== "all") {
    query = query.eq("stage", params.stage);
  }

  const viewStage = viewToStage(params.view);
  if (viewStage) {
    query = query.eq("stage", viewStage);
  } else if (params.view === "recently_modified") {
    const since = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000).toISOString();
    query = query.gte("updated_at", since);
  }

  query = applyOpportunitySort(query, params);

  if (options?.forExport) {
    const { data, count, error } = await query.limit(5000);
    if (error) {
      console.error("opportunities export failed:", error.message);
      return { rows: [], total: 0, params };
    }
    return {
      rows: (data ?? []).map(mapOpportunityRow),
      total: count ?? 0,
      params,
    };
  }

  const from = (params.page - 1) * params.perPage;
  const to = from + params.perPage - 1;
  const { data, count, error } = await query.range(from, to);

  if (error) {
    console.error("opportunities list failed:", error.message);
    return { rows: [], total: 0, params };
  }

  return {
    rows: (data ?? []).map(mapOpportunityRow),
    total: count ?? 0,
    params,
  };
}

export async function fetchOpportunitiesForContact(
  tenantId: string,
  contactId: string,
  options?: { limit?: number },
): Promise<OpportunityRow[]> {
  const limit = options?.limit ?? 50;
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("opportunities")
    .select(SELECT_FIELDS)
    .eq("tenant_id", tenantId)
    .eq("contact_id", contactId)
    .order("updated_at", { ascending: false })
    .limit(limit);

  if (error) {
    console.error("contact opportunities failed:", error.message);
    return [];
  }

  return (data ?? []).map(mapOpportunityRow);
}

export interface OpportunitiesKanbanResult {
  columns: Record<OpportunityStage, OpportunityRow[]>;
  total: number;
  pipeline: OpportunityPipeline;
  params: OpportunitiesListParams;
}

export async function fetchOpportunitiesKanban(
  tenantId: string,
  params: OpportunitiesListParams,
  options?: { pipeline?: OpportunityPipeline },
): Promise<OpportunitiesKanbanResult> {
  const pipeline = options?.pipeline ?? params.pipeline ?? DEFAULT_OPPORTUNITY_PIPELINE;
  const viewStage = viewToStage(params.view);
  const stageFilter =
    params.stage !== "all" ? params.stage : viewStage ?? "all";

  // Apply stage/view filters on kanban (previously wiped, so filters looked broken).
  // Keep recently_modified as a view; map stage views onto `stage`.
  const kanbanParams: OpportunitiesListParams = {
    ...params,
    stage: stageFilter,
    view: params.view === "recently_modified" ? "recently_modified" : "all",
    page: 1,
    perPage: 100,
    sort: "updated_at",
    dir: "desc",
  };

  const { rows, total } = await fetchOpportunitiesList(tenantId, kanbanParams, {
    forExport: true,
    pipeline,
  });

  const columns = emptyStageColumns();
  for (const row of rows) {
    if (columns[row.stage]) {
      columns[row.stage].push(row);
    } else {
      columns.New.push(row);
    }
  }

  return { columns, total, pipeline, params };
}

function csvEscape(value: string): string {
  if (/[",\n\r]/.test(value)) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

export function opportunitiesToCsv(rows: OpportunityRow[]): string {
  const header = [
    "Name",
    "Client",
    "Pipeline",
    "Stage",
    "Type",
    "Amount",
    "Expected Close",
    "Lead Source",
    "Priority",
    "Notes",
    "Created At",
    "Updated At",
  ];
  const lines = [header.join(",")];
  for (const row of rows) {
    lines.push(
      [
        csvEscape(row.name),
        csvEscape(row.contactName ?? ""),
        csvEscape(row.pipeline),
        csvEscape(row.stageLabel),
        csvEscape(row.opportunityType),
        row.amountCents != null ? String(row.amountCents / 100) : "",
        csvEscape(row.expectedCloseDate ?? ""),
        csvEscape(row.leadSource ?? ""),
        csvEscape(row.priority ?? ""),
        csvEscape(row.notes ?? ""),
        csvEscape(row.createdAt),
        csvEscape(row.updatedAt),
      ].join(","),
    );
  }
  return `${lines.join("\n")}\n`;
}
