import { createClient } from "@/lib/supabase/server";
import { resolveCurrentTenant } from "@/lib/tenant/current-tenant";

export async function listLeadOptionsForTenant(): Promise<
  { id: string; label: string }[]
> {
  const { tenantId } = await resolveCurrentTenant();
  if (!tenantId) return [];

  const supabase = await createClient();
  const { data } = await supabase
    .from("contacts")
    .select("id, first_name, last_name, contact_identities(channel, external_id)")
    .eq("tenant_id", tenantId)
    .order("updated_at", { ascending: false })
    .limit(100);

  return (data ?? []).map((contact) => {
    const identities = Array.isArray(contact.contact_identities)
      ? contact.contact_identities
      : contact.contact_identities
        ? [contact.contact_identities]
        : [];
    const sms = identities.find((entry) => entry.channel === "sms");
    const name = [contact.first_name?.trim(), contact.last_name?.trim()]
      .filter(Boolean)
      .join(" ");
    const label = name || (sms?.external_id ? sms.external_id : "Unknown lead");
    return { id: contact.id, label };
  });
}

export interface OpportunityRow {
  id: string;
  name: string;
  stage: string;
  stageLabel: string;
  amountCents: number | null;
  expectedCloseDate: string | null;
  contactName: string | null;
  createdAt: string;
  updatedAt: string;
}

const STAGE_LABELS: Record<string, string> = {
  Qualification: "Qualification",
  Proposal: "Proposal",
  Negotiation: "Negotiation",
  Closed_Won: "Closed Won",
  Closed_Lost: "Closed Lost",
};

export async function fetchOpportunitiesList(
  tenantId: string,
): Promise<OpportunityRow[]> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("opportunities")
    .select(
      `
      id,
      name,
      stage,
      amount_cents,
      expected_close_date,
      created_at,
      updated_at,
      contacts (
        first_name,
        last_name
      )
    `,
    )
    .eq("tenant_id", tenantId)
    .order("updated_at", { ascending: false })
    .limit(100);

  if (error) {
    console.error("opportunities list failed:", error.message);
    return [];
  }

  return (data ?? []).map((row) => {
    const contact = Array.isArray(row.contacts) ? row.contacts[0] : row.contacts;
    const contactName = contact
      ? [contact.first_name?.trim(), contact.last_name?.trim()].filter(Boolean).join(" ") ||
        null
      : null;

    return {
      id: row.id,
      name: row.name,
      stage: row.stage,
      stageLabel: STAGE_LABELS[row.stage] ?? row.stage,
      amountCents: row.amount_cents,
      expectedCloseDate: row.expected_close_date,
      contactName,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  });
}

export interface TaskRow {
  id: string;
  title: string;
  status: string;
  dueAt: string | null;
  contactName: string | null;
  createdAt: string;
  updatedAt: string;
}

export async function fetchTasksList(tenantId: string): Promise<TaskRow[]> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("tasks")
    .select(
      `
      id,
      title,
      status,
      due_at,
      created_at,
      updated_at,
      contacts (
        first_name,
        last_name
      )
    `,
    )
    .eq("tenant_id", tenantId)
    .order("due_at", { ascending: true, nullsFirst: false })
    .order("updated_at", { ascending: false })
    .limit(100);

  if (error) {
    console.error("tasks list failed:", error.message);
    return [];
  }

  return (data ?? []).map((row) => {
    const contact = Array.isArray(row.contacts) ? row.contacts[0] : row.contacts;
    const contactName = contact
      ? [contact.first_name?.trim(), contact.last_name?.trim()].filter(Boolean).join(" ") ||
        null
      : null;

    return {
      id: row.id,
      title: row.title,
      status: row.status,
      dueAt: row.due_at,
      contactName,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  });
}
