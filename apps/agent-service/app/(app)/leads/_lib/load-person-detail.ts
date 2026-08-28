import { notFound, redirect } from "next/navigation";
import { formatLeadStatusLabel } from "@/lib/leads/lead-status";
import { personBasePath, type PersonKind } from "@/lib/crm/person-kind";
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
    score: contact.qualification_score,
    temperature: contact.lead_temperature,
    optedOut: Boolean(contact.opted_out),
    aiSummary: contact.ai_summary?.trim() || null,
    createdAt: contact.created_at,
    updatedAt: contact.updated_at,
  };
}
