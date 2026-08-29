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
    const label = name || (sms?.external_id ? sms.external_id : "Unknown contact");
    return { id: contact.id, label };
  });
}

export async function listAgentOptionsForTenant(): Promise<
  { id: string; label: string }[]
> {
  const { tenantId } = await resolveCurrentTenant();
  if (!tenantId) return [];

  const supabase = await createClient();
  const { data: memberships, error } = await supabase
    .from("memberships")
    .select("user_id, role")
    .eq("tenant_id", tenantId)
    .in("role", ["owner", "agent"])
    .order("created_at", { ascending: true });

  if (error || !memberships?.length) {
    if (error) console.error("agent options failed:", error.message);
    return [];
  }

  const userIds = [...new Set(memberships.map((row) => row.user_id))];
  const { data: profiles } = await supabase
    .from("profiles")
    .select("id, display_name")
    .in("id", userIds);

  const nameById = new Map(
    (profiles ?? []).map((profile) => [
      profile.id,
      profile.display_name?.trim() || null,
    ]),
  );

  return memberships.map((membership) => {
    const name = nameById.get(membership.user_id);
    return {
      id: membership.user_id,
      label: name || `Team member (${membership.role})`,
    };
  });
}

export async function listOpportunityOptionsForTenant(): Promise<
  { id: string; label: string; contactId: string | null }[]
> {
  const { tenantId } = await resolveCurrentTenant();
  if (!tenantId) return [];

  const supabase = await createClient();
  const { data, error } = await supabase
    .from("opportunities")
    .select("id, name, contact_id")
    .eq("tenant_id", tenantId)
    .order("updated_at", { ascending: false })
    .limit(200);

  if (error) {
    console.error("opportunity options failed:", error.message);
    return [];
  }

  return (data ?? []).map((row) => ({
    id: row.id,
    label: row.name?.trim() || "Untitled opportunity",
    contactId: row.contact_id ?? null,
  }));
}

export type { OpportunityRow } from "@/lib/opportunities/opportunities-types";
export { fetchOpportunitiesList } from "@/lib/opportunities/opportunities-list";

export interface TaskRow {
  id: string;
  title: string;
  status: "open" | "done";
  dueAt: string | null;
  startAt: string | null;
  endAt: string | null;
  notes: string | null;
  contactId: string | null;
  contactName: string | null;
  contactRecordType: "lead" | "contact" | null;
  opportunityId: string | null;
  opportunityName: string | null;
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
    `,
    )
    .eq("tenant_id", tenantId)
    .order("due_at", { ascending: true, nullsFirst: false })
    .order("updated_at", { ascending: false })
    .limit(200);

  if (error) {
    console.error("tasks list failed:", error.message);
    return [];
  }

  return (data ?? []).map((row) => {
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
      startAt:
        "start_at" in row && typeof row.start_at === "string" ? row.start_at : null,
      endAt: "end_at" in row && typeof row.end_at === "string" ? row.end_at : null,
      notes: row.notes?.trim() || null,
      contactId: row.contact_id ?? contact?.id ?? null,
      contactName,
      contactRecordType: recordType,
      opportunityId: row.opportunity_id ?? opportunity?.id ?? null,
      opportunityName: opportunity?.name?.trim() || null,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  });
}

export function groupTasksForKanban(rows: TaskRow[]): Record<"open" | "done", TaskRow[]> {
  return {
    open: rows.filter((row) => row.status === "open"),
    done: rows.filter((row) => row.status === "done"),
  };
}
