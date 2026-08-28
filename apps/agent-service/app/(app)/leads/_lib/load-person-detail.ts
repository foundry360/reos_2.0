import { notFound, redirect } from "next/navigation";
import {
  DEFAULT_CONTACT_TYPE,
  formatContactTypeLabel,
  isContactType,
} from "@/lib/crm/contact-type";
import {
  fetchActivitiesForContact,
  fetchTasksForContact,
} from "@/lib/crm/person-activity-lists";
import { formatLeadStatusLabel } from "@/lib/leads/lead-status";
import { personBasePath, type PersonKind } from "@/lib/crm/person-kind";
import { fetchOpportunitiesForContact } from "@/lib/opportunities/opportunities-list";
import { resolveCurrentTenant } from "@/lib/tenant/current-tenant";
import { createClient } from "@/lib/supabase/server";
import { formatPhoneDisplay } from "@/lib/phone-display";
import type { PersonDetailData } from "./person-detail-types";

export async function loadPersonDetail(
  id: string,
  expectedKind: PersonKind,
): Promise<PersonDetailData> {
  const { tenantId } = await resolveCurrentTenant();
  if (!tenantId) notFound();

  const supabase = await createClient();
  const { data: contact } = await supabase
    .from("contacts")
    .select(
      `
      id,
      first_name,
      last_name,
      email,
      record_type,
      lead_status,
      contact_type,
      qualification_score,
      lead_temperature,
      ai_summary,
      opted_out,
      created_at,
      updated_at,
      contact_identities (
        channel,
        external_id
      )
    `,
    )
    .eq("id", id)
    .eq("tenant_id", tenantId)
    .maybeSingle();

  if (!contact) notFound();

  const kind: PersonKind = contact.record_type === "contact" ? "contact" : "lead";
  if (kind !== expectedKind) {
    redirect(`${personBasePath(kind)}/${id}`);
  }

  const identities = Array.isArray(contact.contact_identities)
    ? contact.contact_identities
    : contact.contact_identities
      ? [contact.contact_identities]
      : [];
  const sms = identities.find((entry) => entry.channel === "sms");
  const phone = sms?.external_id
    ? formatPhoneDisplay(
        sms.external_id.startsWith("+")
          ? sms.external_id
          : `+${sms.external_id.replace(/\D/g, "")}`,
      )
    : null;

  const name =
    [contact.first_name?.trim(), contact.last_name?.trim()].filter(Boolean).join(" ") ||
    phone ||
    (kind === "contact" ? "Unknown contact" : "Unknown lead");

  const contactType =
    kind === "contact"
      ? isContactType(contact.contact_type ?? "")
        ? contact.contact_type
        : DEFAULT_CONTACT_TYPE
      : isContactType(contact.contact_type ?? "")
        ? contact.contact_type
        : null;

  const [opportunityRows, tasks, activities] = await Promise.all([
    fetchOpportunitiesForContact(tenantId, contact.id),
    fetchTasksForContact(tenantId, contact.id),
    fetchActivitiesForContact(tenantId, contact.id, { limit: 50 }),
  ]);

  return {
    id: contact.id,
    kind,
    name,
    firstName: contact.first_name?.trim() || "",
    lastName: contact.last_name?.trim() || "",
    email: contact.email?.trim() || null,
    phone,
    leadStatus: contact.lead_status ?? "New",
    statusLabel: formatLeadStatusLabel(contact.lead_status),
    contactType,
    contactTypeLabel: formatContactTypeLabel(contactType),
    score: contact.qualification_score,
    temperature: contact.lead_temperature,
    optedOut: Boolean(contact.opted_out),
    aiSummary: contact.ai_summary?.trim() || null,
    createdAt: contact.created_at,
    updatedAt: contact.updated_at,
    opportunities: opportunityRows.map((row) => ({
      id: row.id,
      name: row.name,
      stageLabel: row.stageLabel,
      amountCents: row.amountCents,
      expectedCloseDate: row.expectedCloseDate,
      updatedAt: row.updatedAt,
    })),
    tasks,
    activities,
  };
}
