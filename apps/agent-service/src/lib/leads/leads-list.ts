import type { LeadStatus } from "@/lib/coordinator";
import type { PersonKind } from "@/lib/crm/person-kind";
import { formatLeadStatusLabel, LEAD_STATUS_VALUES } from "@/lib/leads/lead-status";
import type { LeadsListParams } from "@/lib/leads/leads-list-params";
import type { LeadRow } from "@/lib/leads/leads-types";
import { createClient } from "@/lib/supabase/server";

export type {
  LeadSortColumn,
  LeadStatusFilter,
  LeadsListParams,
  PageSize,
  SortDirection,
} from "@/lib/leads/leads-list-params";
export {
  LEAD_SORT_COLUMNS,
  PAGE_SIZES,
  buildLeadsListQuery,
  buildSortHref,
  parseLeadsListParams,
} from "@/lib/leads/leads-list-params";
export type { LeadRow } from "@/lib/leads/leads-types";

export interface LeadsListResult {
  rows: LeadRow[];
  total: number;
  params: LeadsListParams;
}

interface ContactQueryRow {
  id: string;
  first_name: string | null;
  last_name: string | null;
  email: string | null;
  record_type: PersonKind | null;
  lead_status: LeadStatus;
  qualification_score: number | null;
  lead_temperature: "Hot" | "Warm" | "Cold" | null;
  opted_out: boolean;
  created_at: string;
  updated_at: string;
  contact_identities:
    | { channel: string; external_id: string }[]
    | { channel: string; external_id: string }
    | null;
}

function resolveLeadName(
  firstName: string | null | undefined,
  lastName: string | null | undefined,
  phone: string | null,
): string {
  const parts = [firstName?.trim(), lastName?.trim()].filter(Boolean);
  if (parts.length > 0) return parts.join(" ");
  if (phone) return phone;
  return "Unknown lead";
}

function resolveSmsPhone(
  identities:
    | { channel: string; external_id: string }[]
    | { channel: string; external_id: string }
    | null,
): string | null {
  if (!identities) return null;
  const list = Array.isArray(identities) ? identities : [identities];
  const sms = list.find((entry) => entry.channel === "sms");
  if (!sms?.external_id) return null;
  const digits = sms.external_id.replace(/\D/g, "");
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
  if (sms.external_id.startsWith("+")) return sms.external_id;
  return digits ? `+${digits}` : sms.external_id;
}

function mapContactRows(contacts: ContactQueryRow[]): LeadRow[] {
  return contacts.map((contact) => {
    const phone = resolveSmsPhone(contact.contact_identities);
    return {
      id: contact.id,
      name: resolveLeadName(contact.first_name, contact.last_name, phone),
      firstName: contact.first_name?.trim() || null,
      lastName: contact.last_name?.trim() || null,
      phone,
      email: contact.email?.trim() || null,
      recordType: contact.record_type === "contact" ? "contact" : "lead",
      leadStatus: contact.lead_status,
      leadStatusLabel: formatLeadStatusLabel(contact.lead_status),
      qualificationScore: contact.qualification_score,
      leadTemperature: contact.lead_temperature,
      optedOut: contact.opted_out,
      createdAt: contact.created_at,
      updatedAt: contact.updated_at,
    };
  });
}

async function resolveSearchContactIds(
  supabase: Awaited<ReturnType<typeof createClient>>,
  tenantId: string,
  q: string,
  kind: PersonKind,
): Promise<string[] | null> {
  const term = q.replace(/[%_,]/g, "");
  if (!term) return null;

  const digits = term.replace(/\D/g, "");

  const [{ data: nameMatches }, phoneResult] = await Promise.all([
    supabase
      .from("contacts")
      .select("id")
      .eq("tenant_id", tenantId)
      .eq("record_type", kind)
      .or(`first_name.ilike.%${term}%,last_name.ilike.%${term}%,email.ilike.%${term}%`),
    digits.length >= 3
      ? supabase
          .from("contact_identities")
          .select("contact_id")
          .eq("channel", "sms")
          .ilike("external_id", `%${digits}%`)
      : Promise.resolve({ data: [] as { contact_id: string }[] | null }),
  ]);

  const ids = new Set<string>();
  for (const row of nameMatches ?? []) ids.add(row.id);

  const phoneMatches = phoneResult.data ?? [];
  if (phoneMatches.length > 0) {
    const phoneContactIds = phoneMatches.map((row) => row.contact_id);
    const { data: tenantContacts } = await supabase
      .from("contacts")
      .select("id")
      .eq("tenant_id", tenantId)
      .eq("record_type", kind)
      .in("id", phoneContactIds);
    for (const row of tenantContacts ?? []) ids.add(row.id);
  }

  return [...ids];
}

function applyContactSort(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  query: any,
  params: LeadsListParams,
) {
  const ascending = params.dir === "asc";

  switch (params.sort) {
    case "name":
      return query.order("first_name", { ascending, nullsFirst: false }).order("last_name", {
        ascending,
        nullsFirst: false,
      });
    case "status":
      return query.order("lead_status", { ascending });
    case "score":
      return query.order("qualification_score", { ascending, nullsFirst: false });
    case "temperature":
      return query.order("lead_temperature", { ascending, nullsFirst: false });
    case "created_at":
      return query.order("created_at", { ascending });
    case "updated_at":
    default:
      return query.order("updated_at", { ascending });
  }
}

export async function fetchLeadsList(
  tenantId: string,
  params: LeadsListParams,
  options?: { forExport?: boolean; kind?: PersonKind },
): Promise<LeadsListResult> {
  const kind = options?.kind ?? "lead";
  const supabase = await createClient();

  let contactIds: string[] | null = null;
  if (params.q) {
    contactIds = await resolveSearchContactIds(supabase, tenantId, params.q, kind);
    if (contactIds && contactIds.length === 0) {
      return { rows: [], total: 0, params };
    }
  }

  let query = supabase
    .from("contacts")
    .select(
      `
      id,
      first_name,
      last_name,
      email,
      record_type,
      lead_status,
      qualification_score,
      lead_temperature,
      opted_out,
      created_at,
      updated_at,
      contact_identities (
        channel,
        external_id
      )
    `,
      { count: "exact" },
    )
    .eq("tenant_id", tenantId)
    .eq("record_type", kind);

  if (contactIds) {
    query = query.in("id", contactIds);
  }

  if (params.status !== "all") {
    query = query.eq("lead_status", params.status);
  }

  const now = Date.now();
  const daysAgo = (days: number) => new Date(now - days * 24 * 60 * 60 * 1000).toISOString();

  switch (params.view) {
    case "new":
      query = query.eq("lead_status", "New");
      break;
    case "working":
      query = query.eq("lead_status", "Working");
      break;
    case "contacted":
      query = query.eq("lead_status", "Contacted");
      break;
    case "qualified":
      query = query.eq("lead_status", "Qualified");
      break;
    case "converted":
      query = query.eq("lead_status", "Converted");
      break;
    case "recently_modified":
      query = query.gte("updated_at", daysAgo(14));
      break;
    case "hot":
      query = query.eq("lead_temperature", "Hot");
      break;
    case "opted_out":
      query = query.eq("opted_out", true);
      break;
    case "never_contacted": {
      const { data: messaged } = await supabase
        .from("messages")
        .select("contact_id")
        .eq("tenant_id", tenantId);
      const messagedIds = [...new Set((messaged ?? []).map((row) => row.contact_id).filter(Boolean))];
      if (messagedIds.length > 0) {
        query = query.not(
          "id",
          "in",
          `(${messagedIds.map((id) => `"${id}"`).join(",")})`,
        );
      }
      break;
    }
    case "all":
    default:
      break;
  }

  query = applyContactSort(query, params);

  if (options?.forExport) {
    const { data, count, error } = await query.limit(5000);
    if (error) {
      console.error("leads export query failed:", error.message);
      return { rows: [], total: 0, params };
    }
    return {
      rows: mapContactRows((data ?? []) as ContactQueryRow[]),
      total: count ?? 0,
      params,
    };
  }

  const from = (params.page - 1) * params.perPage;
  const to = from + params.perPage - 1;

  const { data, count, error } = await query.range(from, to);

  if (error) {
    console.error("leads list query failed:", error.message);
    return { rows: [], total: 0, params };
  }

  return {
    rows: mapContactRows((data ?? []) as ContactQueryRow[]),
    total: count ?? 0,
    params,
  };
}

const STATUS_PIPELINE_VIEWS = new Set([
  "new",
  "working",
  "contacted",
  "qualified",
  "converted",
]);

export interface PeopleKanbanResult {
  columns: Record<LeadStatus, LeadRow[]>;
  total: number;
  params: LeadsListParams;
}

/** Kanban board: all pipeline columns, optional non-status filters preserved. */
export async function fetchPeopleKanban(
  tenantId: string,
  params: LeadsListParams,
  options?: { kind?: PersonKind },
): Promise<PeopleKanbanResult> {
  const emptyColumns = LEAD_STATUS_VALUES.reduce(
    (acc, status) => {
      acc[status] = [];
      return acc;
    },
    {} as Record<LeadStatus, LeadRow[]>,
  );

  const kanbanParams: LeadsListParams = {
    ...params,
    // Always show full pipeline columns on the board.
    status: "all",
    view: STATUS_PIPELINE_VIEWS.has(params.view) ? "all" : params.view,
    page: 1,
    perPage: 100,
    sort: "updated_at",
    dir: "desc",
  };

  const { rows, total } = await fetchLeadsList(tenantId, kanbanParams, {
    forExport: true,
    kind: options?.kind ?? "lead",
  });

  const columns = { ...emptyColumns };
  for (const row of rows) {
    if (columns[row.leadStatus]) {
      columns[row.leadStatus].push(row);
    } else {
      columns.New.push(row);
    }
  }

  return { columns, total, params };
}

function csvEscape(value: string): string {
  if (/[",\n\r]/.test(value)) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

export function leadsToCsv(rows: LeadRow[]): string {
  const header = [
    "Name",
    "Phone",
    "Email",
    "Status",
    "Score",
    "Temperature",
    "Opted Out",
    "Created At",
    "Updated At",
  ];
  const lines = [header.join(",")];
  for (const row of rows) {
    lines.push(
      [
        csvEscape(row.name),
        csvEscape(row.phone ?? ""),
        csvEscape(row.email ?? ""),
        csvEscape(row.leadStatusLabel),
        row.qualificationScore != null ? String(row.qualificationScore) : "",
        csvEscape(row.leadTemperature ?? ""),
        row.optedOut ? "Yes" : "No",
        csvEscape(row.createdAt),
        csvEscape(row.updatedAt),
      ].join(","),
    );
  }
  return `${lines.join("\n")}\n`;
}
