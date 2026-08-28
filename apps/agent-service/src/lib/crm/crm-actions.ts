"use server";

import { revalidatePath } from "next/cache";
import { isPersonKind, personBasePath, personSingular, type PersonKind } from "@/lib/crm/person-kind";
import {
  DEFAULT_CONTACT_TYPE,
  formatContactTypeLabel,
  isContactType,
  type ContactType,
} from "@/lib/crm/contact-type";
import { formatLeadStatusLabel, isLeadStatus } from "@/lib/leads/lead-status";
import {
  formatOpportunityStageLabel,
  isOpportunityPipeline,
  isOpportunityStage,
  isOpportunityStageForPipeline,
} from "@/lib/opportunities/opportunity-stages";
import {
  DEFAULT_OPPORTUNITY_TYPE,
  isOpportunityLeadSource,
  isOpportunityPriority,
  isOpportunityType,
} from "@/lib/opportunities/opportunity-fields";
import { isActivityType, type StoredActivityType } from "@/lib/crm/person-activities";
import { parsePhoneForStorage } from "@/lib/phone-display";
import { resolveCurrentTenant } from "@/lib/tenant/current-tenant";
import { createClient } from "@/lib/supabase/server";
import type { SupabaseClient } from "@supabase/supabase-js";

export interface CrmActionResult {
  ok: boolean;
  error?: string;
  id?: string;
  kind?: PersonKind;
}

function parsePersonKind(value: FormDataEntryValue | null): PersonKind {
  const raw = String(value ?? "").trim();
  return isPersonKind(raw) ? raw : "lead";
}

function revalidatePersonPaths(kind: PersonKind, id?: string) {
  const base = personBasePath(kind);
  revalidatePath(base);
  if (id) revalidatePath(`${base}/${id}`);
  revalidatePath("/");
}

function nextKindAfterStatus(kind: PersonKind, status: string): PersonKind {
  if (kind === "lead" && status === "Converted") return "contact";
  return kind;
}

function revalidateAfterPersonUpdate(fromKind: PersonKind, toKind: PersonKind, id: string) {
  revalidatePersonPaths(fromKind, id);
  if (toKind !== fromKind) {
    revalidatePersonPaths(toKind, id);
  }
}

async function requireTenantId(): Promise<{ tenantId: string } | CrmActionResult> {
  const { tenantId } = await resolveCurrentTenant();
  if (!tenantId) {
    return {
      ok: false,
      error: "Your account is not linked to a workspace yet.",
    };
  }
  return { tenantId };
}

function parseOptionalContactId(value: FormDataEntryValue | null): string | null {
  const raw = String(value ?? "").trim();
  if (!raw || raw === "none") return null;
  return raw;
}

function parseAmountCents(value: FormDataEntryValue | null): number | null | { error: string } {
  const raw = String(value ?? "").trim();
  if (!raw) return null;
  const normalized = raw.replace(/[$,]/g, "");
  const amount = Number(normalized);
  if (!Number.isFinite(amount) || amount < 0) {
    return { error: "Enter a valid amount." };
  }
  return Math.round(amount * 100);
}

function formatUsdCents(cents: number | null | undefined): string {
  if (cents == null) return "—";
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 0,
  }).format(cents / 100);
}

function formatCloseDate(value: string | null | undefined): string {
  if (!value) return "—";
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  }).format(new Date(`${value}T12:00:00`));
}

async function logContactActivity(
  supabase: SupabaseClient,
  params: {
    tenantId: string;
    contactId: string | null | undefined;
    activityType: StoredActivityType;
    title: string;
    body?: string | null;
  },
): Promise<void> {
  if (!params.contactId) return;

  const payload = {
    tenant_id: params.tenantId,
    contact_id: params.contactId,
    activity_type: params.activityType,
    title: params.title,
    body: params.body?.trim() || null,
    occurred_at: new Date().toISOString(),
  };

  let { error } = await supabase.from("contact_activities").insert(payload);
  if (error && /activity_type|check constraint/i.test(error.message)) {
    ({ error } = await supabase.from("contact_activities").insert({
      ...payload,
      activity_type: "other",
    }));
  }

  if (error) {
    const missingTable = /contact_activities|schema cache/i.test(error.message);
    if (!missingTable) {
      console.error("log contact activity failed:", error.message);
    }
  }
}

function displayText(value: string | null | undefined): string {
  const trimmed = value?.trim();
  return trimmed ? trimmed : "—";
}

function personDisplayName(
  firstName: string | null | undefined,
  lastName: string | null | undefined,
): string {
  const name = [firstName?.trim(), lastName?.trim()].filter(Boolean).join(" ");
  return name || "Untitled";
}

export async function createLeadAction(formData: FormData): Promise<CrmActionResult> {
  const tenant = await requireTenantId();
  if (!("tenantId" in tenant)) return tenant;

  const kind = parsePersonKind(formData.get("recordType"));
  const label = personSingular(kind);
  const firstName = String(formData.get("firstName") ?? "").trim();
  const lastName = String(formData.get("lastName") ?? "").trim();
  const email = String(formData.get("email") ?? "").trim().toLowerCase();
  const phoneRaw = String(formData.get("phone") ?? "");
  const statusRaw = String(formData.get("status") ?? "New");
  const status = isLeadStatus(statusRaw) ? statusRaw : "New";
  const contactTypeRaw = String(formData.get("contactType") ?? "").trim();
  const contactType: ContactType | null = isContactType(contactTypeRaw)
    ? contactTypeRaw
    : kind === "contact"
      ? DEFAULT_CONTACT_TYPE
      : null;

  const phoneResult = parsePhoneForStorage(phoneRaw);
  if (!phoneResult.ok) {
    return { ok: false, error: phoneResult.error };
  }

  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return { ok: false, error: "Enter a valid email address." };
  }

  if (!firstName && !lastName && !phoneResult.phone && !email) {
    return { ok: false, error: "Enter a name, email, or phone number." };
  }

  const supabase = await createClient();

  if (phoneResult.phone) {
    const digits = phoneResult.phone.replace(/\D/g, "");
    const { data: existingIdentities } = await supabase
      .from("contact_identities")
      .select("contact_id")
      .eq("channel", "sms")
      .or(`external_id.eq.${digits},external_id.eq.${phoneResult.phone}`);

    const existingIds = (existingIdentities ?? []).map((row) => row.contact_id);
    if (existingIds.length > 0) {
      const { data: existingInTenant } = await supabase
        .from("contacts")
        .select("id")
        .eq("tenant_id", tenant.tenantId)
        .in("id", existingIds)
        .limit(1);
      if (existingInTenant && existingInTenant.length > 0) {
        return { ok: false, error: `A ${label} with this phone number already exists.` };
      }
    }
  }

  const { data: contact, error: contactError } = await supabase
    .from("contacts")
    .insert({
      tenant_id: tenant.tenantId,
      first_name: firstName || null,
      last_name: lastName || null,
      email: email || null,
      lead_status: kind === "contact" ? "Converted" : status,
      record_type: kind,
      contact_type: contactType,
    })
    .select("id")
    .single();

  if (contactError || !contact) {
    return { ok: false, error: contactError?.message ?? `Could not create ${label}.` };
  }

  if (phoneResult.phone) {
    const digits = phoneResult.phone.replace(/\D/g, "");
    const { error: identityError } = await supabase.from("contact_identities").insert({
      contact_id: contact.id,
      channel: "sms",
      external_id: digits,
    });

    if (identityError) {
      await supabase.from("contacts").delete().eq("id", contact.id);
      if (identityError.code === "23505") {
        return { ok: false, error: `A ${label} with this phone number already exists.` };
      }
      return { ok: false, error: identityError.message };
    }
  }

  const createdName = personDisplayName(firstName, lastName);
  await logContactActivity(supabase, {
    tenantId: tenant.tenantId,
    contactId: contact.id,
    activityType: "contact",
    title: `Created ${label}: ${createdName}`,
    body: [
      email ? `Email ${email}` : null,
      phoneResult.phone ? `Phone ${phoneResult.phone}` : null,
      kind === "lead" ? `Status ${formatLeadStatusLabel(status)}` : null,
      kind === "contact" && contactType
        ? `Type ${formatContactTypeLabel(contactType)}`
        : null,
    ]
      .filter(Boolean)
      .join(" · "),
  });

  revalidatePersonPaths(kind);
  return { ok: true, id: contact.id };
}

export async function updateLeadAction(formData: FormData): Promise<CrmActionResult> {
  const tenant = await requireTenantId();
  if (!("tenantId" in tenant)) return tenant;

  const leadId = String(formData.get("leadId") ?? "").trim();
  if (!leadId) {
    return { ok: false, error: "Record not found." };
  }

  const firstName = String(formData.get("firstName") ?? "").trim();
  const lastName = String(formData.get("lastName") ?? "").trim();
  const email = String(formData.get("email") ?? "").trim().toLowerCase();
  const phoneRaw = String(formData.get("phone") ?? "");
  const statusRaw = String(formData.get("status") ?? "New");
  const contactTypeRaw = String(formData.get("contactType") ?? "").trim();

  const phoneResult = parsePhoneForStorage(phoneRaw);
  if (!phoneResult.ok) {
    return { ok: false, error: phoneResult.error };
  }

  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return { ok: false, error: "Enter a valid email address." };
  }

  if (!firstName && !lastName && !phoneResult.phone && !email) {
    return { ok: false, error: "Enter a name, email, or phone number." };
  }

  const supabase = await createClient();

  const { data: existing } = await supabase
    .from("contacts")
    .select("id, record_type, contact_type, lead_status, first_name, last_name, email")
    .eq("id", leadId)
    .eq("tenant_id", tenant.tenantId)
    .maybeSingle();

  if (!existing) {
    return { ok: false, error: "Record not found." };
  }

  const { data: existingSmsIdentity } = await supabase
    .from("contact_identities")
    .select("id, external_id")
    .eq("contact_id", leadId)
    .eq("channel", "sms")
    .maybeSingle();

  const kind: PersonKind = existing.record_type === "contact" ? "contact" : "lead";
  const label = personSingular(kind);

  let nextKind: PersonKind = kind;
  const updates: Record<string, string | null> = {
    first_name: firstName || null,
    last_name: lastName || null,
    email: email || null,
  };

  if (kind === "lead") {
    const status = isLeadStatus(statusRaw) ? statusRaw : "New";
    updates.lead_status = status;
    nextKind = nextKindAfterStatus(kind, status);
    if (nextKind !== kind) {
      updates.record_type = nextKind;
      updates.contact_type = isContactType(contactTypeRaw)
        ? contactTypeRaw
        : isContactType(existing.contact_type ?? "")
          ? existing.contact_type
          : DEFAULT_CONTACT_TYPE;
    }
  } else {
    updates.contact_type = isContactType(contactTypeRaw)
      ? contactTypeRaw
      : isContactType(existing.contact_type ?? "")
        ? existing.contact_type
        : DEFAULT_CONTACT_TYPE;
  }

  if (phoneResult.phone) {
    const digits = phoneResult.phone.replace(/\D/g, "");
    const { data: existingIdentities } = await supabase
      .from("contact_identities")
      .select("contact_id")
      .eq("channel", "sms")
      .or(`external_id.eq.${digits},external_id.eq.${phoneResult.phone}`);

    const conflictIds = (existingIdentities ?? [])
      .map((row) => row.contact_id)
      .filter((id) => id !== leadId);

    if (conflictIds.length > 0) {
      const { data: existingInTenant } = await supabase
        .from("contacts")
        .select("id")
        .eq("tenant_id", tenant.tenantId)
        .in("id", conflictIds)
        .limit(1);
      if (existingInTenant && existingInTenant.length > 0) {
        return { ok: false, error: `A ${label} with this phone number already exists.` };
      }
    }
  }

  const { error: contactError } = await supabase
    .from("contacts")
    .update(updates)
    .eq("id", leadId)
    .eq("tenant_id", tenant.tenantId);

  if (contactError) {
    return { ok: false, error: contactError.message };
  }

  const { data: smsIdentity } = existingSmsIdentity
    ? { data: existingSmsIdentity }
    : await supabase
        .from("contact_identities")
        .select("id, external_id")
        .eq("contact_id", leadId)
        .eq("channel", "sms")
        .maybeSingle();

  if (phoneResult.phone) {
    const digits = phoneResult.phone.replace(/\D/g, "");
    if (smsIdentity) {
      if (smsIdentity.external_id !== digits) {
        const { error: identityError } = await supabase
          .from("contact_identities")
          .update({ external_id: digits })
          .eq("id", smsIdentity.id);
        if (identityError) {
          if (identityError.code === "23505") {
            return { ok: false, error: `A ${label} with this phone number already exists.` };
          }
          return { ok: false, error: identityError.message };
        }
      }
    } else {
      const { error: identityError } = await supabase.from("contact_identities").insert({
        contact_id: leadId,
        channel: "sms",
        external_id: digits,
      });
      if (identityError) {
        if (identityError.code === "23505") {
          return { ok: false, error: `A ${label} with this phone number already exists.` };
        }
        return { ok: false, error: identityError.message };
      }
    }
  } else if (smsIdentity) {
    const { error: identityError } = await supabase
      .from("contact_identities")
      .delete()
      .eq("id", smsIdentity.id);
    if (identityError) {
      return { ok: false, error: identityError.message };
    }
  }

  const previousPhone = existingSmsIdentity?.external_id ?? null;
  const nextPhone = phoneResult.phone ? phoneResult.phone.replace(/\D/g, "") : null;
  const changes: string[] = [];
  if ((existing.first_name ?? "") !== firstName) {
    changes.push(`First name ${displayText(existing.first_name)} → ${displayText(firstName)}`);
  }
  if ((existing.last_name ?? "") !== lastName) {
    changes.push(`Last name ${displayText(existing.last_name)} → ${displayText(lastName)}`);
  }
  if ((existing.email ?? "") !== email) {
    changes.push(`Email ${displayText(existing.email)} → ${displayText(email)}`);
  }
  if ((previousPhone ?? "") !== (nextPhone ?? "")) {
    changes.push(`Phone ${displayText(previousPhone)} → ${displayText(nextPhone)}`);
  }
  if (kind === "lead" && existing.lead_status !== updates.lead_status) {
    changes.push(
      `Status ${formatLeadStatusLabel(existing.lead_status ?? "")} → ${formatLeadStatusLabel(String(updates.lead_status ?? ""))}`,
    );
  }
  if (kind === "contact" && (existing.contact_type ?? null) !== (updates.contact_type ?? null)) {
    changes.push(
      `Type ${formatContactTypeLabel(existing.contact_type)} → ${formatContactTypeLabel(String(updates.contact_type ?? ""))}`,
    );
  }
  if (nextKind !== kind) {
    changes.push(`Converted to ${personSingular(nextKind)}`);
  }

  if (changes.length > 0) {
    await logContactActivity(supabase, {
      tenantId: tenant.tenantId,
      contactId: leadId,
      activityType: "contact",
      title: `Updated ${label}: ${personDisplayName(firstName, lastName)}`,
      body: changes.join(" · "),
    });
  }

  revalidateAfterPersonUpdate(kind, nextKind, leadId);
  return { ok: true, id: leadId, kind: nextKind };
}

export async function updateLeadStatusAction(
  leadId: string,
  status: string,
): Promise<CrmActionResult> {
  const tenant = await requireTenantId();
  if (!("tenantId" in tenant)) return tenant;

  const id = leadId.trim();
  if (!id) {
    return { ok: false, error: "Record not found." };
  }
  if (!isLeadStatus(status)) {
    return { ok: false, error: "Invalid status." };
  }

  const supabase = await createClient();
  const { data: existing } = await supabase
    .from("contacts")
    .select("id, record_type, lead_status, first_name, last_name")
    .eq("id", id)
    .eq("tenant_id", tenant.tenantId)
    .maybeSingle();

  if (!existing) {
    return { ok: false, error: "Record not found." };
  }

  const kind: PersonKind = existing.record_type === "contact" ? "contact" : "lead";
  if (kind === "contact") {
    return { ok: false, error: "Use contact type to update contacts." };
  }
  if (existing.lead_status === status) {
    return { ok: true, id, kind };
  }

  const nextKind = nextKindAfterStatus(kind, status);
  const { error } = await supabase
    .from("contacts")
    .update({
      lead_status: status,
      ...(nextKind !== kind
        ? { record_type: nextKind, contact_type: DEFAULT_CONTACT_TYPE }
        : {}),
    })
    .eq("id", id)
    .eq("tenant_id", tenant.tenantId);

  if (error) {
    return { ok: false, error: error.message };
  }

  await logContactActivity(supabase, {
    tenantId: tenant.tenantId,
    contactId: id,
    activityType: "contact",
    title: `Updated lead: ${personDisplayName(existing.first_name, existing.last_name)}`,
    body: [
      `Status ${formatLeadStatusLabel(existing.lead_status ?? "")} → ${formatLeadStatusLabel(status)}`,
      nextKind !== kind ? `Converted to ${personSingular(nextKind)}` : null,
    ]
      .filter(Boolean)
      .join(" · "),
  });

  revalidateAfterPersonUpdate(kind, nextKind, id);
  return { ok: true, id, kind: nextKind };
}

export async function updateContactTypeAction(
  contactId: string,
  contactType: string,
): Promise<CrmActionResult> {
  const tenant = await requireTenantId();
  if (!("tenantId" in tenant)) return tenant;

  const id = contactId.trim();
  if (!id) {
    return { ok: false, error: "Contact not found." };
  }
  if (!isContactType(contactType)) {
    return { ok: false, error: "Invalid contact type." };
  }

  const supabase = await createClient();
  const { data: existing } = await supabase
    .from("contacts")
    .select("id, record_type, contact_type, first_name, last_name")
    .eq("id", id)
    .eq("tenant_id", tenant.tenantId)
    .maybeSingle();

  if (!existing) {
    return { ok: false, error: "Contact not found." };
  }
  if (existing.record_type !== "contact") {
    return { ok: false, error: "Only contacts have a contact type." };
  }
  if (existing.contact_type === contactType) {
    return { ok: true, id, kind: "contact" };
  }

  const { error } = await supabase
    .from("contacts")
    .update({ contact_type: contactType })
    .eq("id", id)
    .eq("tenant_id", tenant.tenantId);

  if (error) {
    return { ok: false, error: error.message };
  }

  await logContactActivity(supabase, {
    tenantId: tenant.tenantId,
    contactId: id,
    activityType: "contact",
    title: `Updated contact: ${personDisplayName(existing.first_name, existing.last_name)}`,
    body: `Type ${formatContactTypeLabel(existing.contact_type)} → ${formatContactTypeLabel(contactType)}`,
  });

  revalidateAfterPersonUpdate("contact", "contact", id);
  return { ok: true, id, kind: "contact" };
}

export async function deleteLeadsAction(
  leadIds: string[],
): Promise<CrmActionResult & { deleted?: number }> {
  const tenant = await requireTenantId();
  if (!("tenantId" in tenant)) return tenant;

  const ids = [...new Set(leadIds.map((id) => id.trim()).filter(Boolean))];
  if (ids.length === 0) {
    return { ok: false, error: "Select at least one record to delete." };
  }
  if (ids.length > 200) {
    return { ok: false, error: "You can delete up to 200 records at a time." };
  }

  const supabase = await createClient();
  const { data, error } = await supabase
    .from("contacts")
    .delete()
    .eq("tenant_id", tenant.tenantId)
    .in("id", ids)
    .select("id");

  if (error) {
    return { ok: false, error: error.message };
  }

  revalidatePath("/leads");
  revalidatePath("/contacts");
  revalidatePath("/");
  return { ok: true, deleted: data?.length ?? 0 };
}

export async function createOpportunityAction(
  formData: FormData,
): Promise<CrmActionResult> {
  const tenant = await requireTenantId();
  if (!("tenantId" in tenant)) return tenant;

  const name = String(formData.get("name") ?? "").trim();
  const pipelineRaw = String(formData.get("pipeline") ?? "").trim();
  if (!isOpportunityPipeline(pipelineRaw)) {
    return { ok: false, error: "Pipeline is required." };
  }
  const pipeline = pipelineRaw;
  const stageRaw = String(formData.get("stage") ?? "").trim();
  if (!isOpportunityStageForPipeline(stageRaw, pipeline)) {
    return { ok: false, error: "Select a stage for the chosen pipeline." };
  }
  const stage = stageRaw;
  const typeRaw = String(formData.get("opportunityType") ?? DEFAULT_OPPORTUNITY_TYPE).trim();
  const opportunityType = isOpportunityType(typeRaw) ? typeRaw : DEFAULT_OPPORTUNITY_TYPE;
  const contactId = parseOptionalContactId(formData.get("contactId"));
  const assignedAgentId = parseOptionalContactId(formData.get("assignedAgentId"));
  const leadSourceRaw = String(formData.get("leadSource") ?? "").trim();
  const leadSource = isOpportunityLeadSource(leadSourceRaw) ? leadSourceRaw : null;
  const priorityRaw = String(formData.get("priority") ?? "").trim();
  const priority = isOpportunityPriority(priorityRaw) ? priorityRaw : null;
  const expectedCloseDate = String(formData.get("expectedCloseDate") ?? "").trim() || null;
  const notes = String(formData.get("notes") ?? "").trim() || null;
  const amount = parseAmountCents(formData.get("amount"));

  if (!name) {
    return { ok: false, error: "Opportunity name is required." };
  }
  if (!contactId) {
    return { ok: false, error: "Contact is required." };
  }
  if (amount && typeof amount === "object" && "error" in amount) {
    return { ok: false, error: amount.error };
  }

  const supabase = await createClient();

  const { data: contact } = await supabase
    .from("contacts")
    .select("id")
    .eq("id", contactId)
    .eq("tenant_id", tenant.tenantId)
    .maybeSingle();
  if (!contact) {
    return { ok: false, error: "Selected contact was not found." };
  }

  if (assignedAgentId) {
    const { data: membership } = await supabase
      .from("memberships")
      .select("user_id")
      .eq("tenant_id", tenant.tenantId)
      .eq("user_id", assignedAgentId)
      .maybeSingle();
    if (!membership) {
      return { ok: false, error: "Selected agent was not found." };
    }
  }

  const { data: opportunity, error } = await supabase
    .from("opportunities")
    .insert({
      tenant_id: tenant.tenantId,
      contact_id: contactId,
      name,
      pipeline,
      stage,
      opportunity_type: opportunityType,
      assigned_agent_id: assignedAgentId,
      lead_source: leadSource,
      priority,
      amount_cents: typeof amount === "number" ? amount : null,
      expected_close_date: expectedCloseDate,
      notes,
    })
    .select("id")
    .single();

  if (error || !opportunity) {
    return { ok: false, error: error?.message ?? "Could not create opportunity." };
  }

  await logContactActivity(supabase, {
    tenantId: tenant.tenantId,
    contactId,
    activityType: "opportunity",
    title: `Created opportunity: ${name}`,
    body: [
      `Stage ${formatOpportunityStageLabel(stage)}`,
      typeof amount === "number" ? `Amount ${formatUsdCents(amount)}` : null,
      expectedCloseDate ? `Close ${formatCloseDate(expectedCloseDate)}` : null,
    ]
      .filter(Boolean)
      .join(" · "),
  });

  revalidatePath("/opportunities");
  revalidatePath(`/leads/${contactId}`);
  revalidatePath(`/contacts/${contactId}`);
  return { ok: true, id: opportunity.id };
}

export async function updateOpportunityAction(
  formData: FormData,
): Promise<CrmActionResult> {
  const tenant = await requireTenantId();
  if (!("tenantId" in tenant)) return tenant;

  const id = String(formData.get("opportunityId") ?? "").trim();
  if (!id) {
    return { ok: false, error: "Opportunity not found." };
  }

  const name = String(formData.get("name") ?? "").trim();
  const pipelineRaw = String(formData.get("pipeline") ?? "").trim();
  if (!isOpportunityPipeline(pipelineRaw)) {
    return { ok: false, error: "Pipeline is required." };
  }
  const pipeline = pipelineRaw;
  const stageRaw = String(formData.get("stage") ?? "").trim();
  if (!isOpportunityStageForPipeline(stageRaw, pipeline)) {
    return { ok: false, error: "Select a stage for the chosen pipeline." };
  }
  const stage = stageRaw;
  const typeRaw = String(formData.get("opportunityType") ?? DEFAULT_OPPORTUNITY_TYPE).trim();
  const opportunityType = isOpportunityType(typeRaw) ? typeRaw : DEFAULT_OPPORTUNITY_TYPE;
  const contactId = parseOptionalContactId(formData.get("contactId"));
  const assignedAgentId = parseOptionalContactId(formData.get("assignedAgentId"));
  const leadSourceRaw = String(formData.get("leadSource") ?? "").trim();
  const leadSource = isOpportunityLeadSource(leadSourceRaw) ? leadSourceRaw : null;
  const priorityRaw = String(formData.get("priority") ?? "").trim();
  const priority = isOpportunityPriority(priorityRaw) ? priorityRaw : null;
  const expectedCloseDate = String(formData.get("expectedCloseDate") ?? "").trim() || null;
  const notes = String(formData.get("notes") ?? "").trim() || null;
  const amount = parseAmountCents(formData.get("amount"));

  if (!name) {
    return { ok: false, error: "Opportunity name is required." };
  }
  if (!contactId) {
    return { ok: false, error: "Contact is required." };
  }
  if (amount && typeof amount === "object" && "error" in amount) {
    return { ok: false, error: amount.error };
  }

  const supabase = await createClient();

  const { data: existing } = await supabase
    .from("opportunities")
    .select(
      `
      id,
      contact_id,
      name,
      pipeline,
      stage,
      opportunity_type,
      assigned_agent_id,
      lead_source,
      priority,
      amount_cents,
      expected_close_date,
      notes
    `,
    )
    .eq("id", id)
    .eq("tenant_id", tenant.tenantId)
    .maybeSingle();
  if (!existing) {
    return { ok: false, error: "Opportunity not found." };
  }

  const { data: contact } = await supabase
    .from("contacts")
    .select("id")
    .eq("id", contactId)
    .eq("tenant_id", tenant.tenantId)
    .maybeSingle();
  if (!contact) {
    return { ok: false, error: "Selected contact was not found." };
  }

  if (assignedAgentId) {
    const { data: membership } = await supabase
      .from("memberships")
      .select("user_id")
      .eq("tenant_id", tenant.tenantId)
      .eq("user_id", assignedAgentId)
      .maybeSingle();
    if (!membership) {
      return { ok: false, error: "Selected agent was not found." };
    }
  }

  const { error } = await supabase
    .from("opportunities")
    .update({
      contact_id: contactId,
      name,
      pipeline,
      stage,
      opportunity_type: opportunityType,
      assigned_agent_id: assignedAgentId,
      lead_source: leadSource,
      priority,
      amount_cents: typeof amount === "number" ? amount : null,
      expected_close_date: expectedCloseDate,
      notes,
    })
    .eq("id", id)
    .eq("tenant_id", tenant.tenantId);

  if (error) {
    return { ok: false, error: error.message };
  }

  const amountCents = typeof amount === "number" ? amount : null;
  const changes: string[] = [];
  if (existing.name !== name) {
    changes.push(`Name ${existing.name} → ${name}`);
  }
  if (existing.pipeline !== pipeline) {
    changes.push(`Pipeline ${existing.pipeline} → ${pipeline}`);
  }
  if (existing.stage !== stage) {
    changes.push(
      `Stage ${formatOpportunityStageLabel(existing.stage)} → ${formatOpportunityStageLabel(stage)}`,
    );
  }
  if ((existing.opportunity_type ?? null) !== opportunityType) {
    changes.push(
      `Type ${displayText(existing.opportunity_type)} → ${displayText(opportunityType)}`,
    );
  }
  if ((existing.amount_cents ?? null) !== amountCents) {
    changes.push(
      `Amount ${formatUsdCents(existing.amount_cents)} → ${formatUsdCents(amountCents)}`,
    );
  }
  if ((existing.expected_close_date ?? null) !== expectedCloseDate) {
    changes.push(
      `Close date ${formatCloseDate(existing.expected_close_date)} → ${formatCloseDate(expectedCloseDate)}`,
    );
  }
  if ((existing.priority ?? null) !== priority) {
    changes.push(`Priority ${displayText(existing.priority)} → ${displayText(priority)}`);
  }
  if ((existing.lead_source ?? null) !== leadSource) {
    changes.push(
      `Lead source ${displayText(existing.lead_source)} → ${displayText(leadSource)}`,
    );
  }
  if ((existing.assigned_agent_id ?? null) !== assignedAgentId) {
    changes.push("Assigned agent changed");
  }
  if ((existing.notes ?? null) !== notes) {
    changes.push("Notes updated");
  }
  if ((existing.contact_id ?? null) !== contactId) {
    changes.push("Contact changed");
  }

  if (changes.length > 0) {
    await logContactActivity(supabase, {
      tenantId: tenant.tenantId,
      contactId,
      activityType: "opportunity",
      title: `Updated opportunity: ${name}`,
      body: changes.join(" · "),
    });
    if (existing.contact_id && existing.contact_id !== contactId) {
      await logContactActivity(supabase, {
        tenantId: tenant.tenantId,
        contactId: existing.contact_id,
        activityType: "opportunity",
        title: `Unlinked opportunity: ${existing.name}`,
        body: `Moved to another contact`,
      });
    }
  }

  revalidatePath("/opportunities");
  revalidatePath(`/opportunities/${id}`);
  revalidatePath(`/leads/${contactId}`);
  revalidatePath(`/contacts/${contactId}`);
  if (existing.contact_id && existing.contact_id !== contactId) {
    revalidatePath(`/leads/${existing.contact_id}`);
    revalidatePath(`/contacts/${existing.contact_id}`);
  }
  return { ok: true, id };
}

export async function deleteOpportunitiesAction(
  opportunityIds: string[],
): Promise<CrmActionResult & { deleted?: number }> {
  const tenant = await requireTenantId();
  if (!("tenantId" in tenant)) return tenant;

  const ids = [...new Set(opportunityIds.map((id) => id.trim()).filter(Boolean))];
  if (ids.length === 0) {
    return { ok: false, error: "Select at least one opportunity to delete." };
  }
  if (ids.length > 200) {
    return { ok: false, error: "You can delete up to 200 opportunities at a time." };
  }

  const supabase = await createClient();
  const { data: existing } = await supabase
    .from("opportunities")
    .select("id, contact_id, name")
    .eq("tenant_id", tenant.tenantId)
    .in("id", ids);

  const { data, error } = await supabase
    .from("opportunities")
    .delete()
    .eq("tenant_id", tenant.tenantId)
    .in("id", ids)
    .select("id");

  if (error) {
    return { ok: false, error: error.message };
  }

  for (const row of existing ?? []) {
    if (!row.contact_id) continue;
    await logContactActivity(supabase, {
      tenantId: tenant.tenantId,
      contactId: row.contact_id,
      activityType: "opportunity",
      title: `Deleted opportunity: ${row.name}`,
    });
  }

  revalidatePath("/opportunities");
  for (const row of existing ?? []) {
    if (row.contact_id) {
      revalidatePath(`/leads/${row.contact_id}`);
      revalidatePath(`/contacts/${row.contact_id}`);
    }
  }
  return { ok: true, deleted: data?.length ?? 0 };
}

export async function updateOpportunityStageAction(
  opportunityId: string,
  stage: string,
): Promise<CrmActionResult> {
  const tenant = await requireTenantId();
  if (!("tenantId" in tenant)) return tenant;

  const id = opportunityId.trim();
  if (!id) {
    return { ok: false, error: "Opportunity not found." };
  }
  if (!isOpportunityStage(stage)) {
    return { ok: false, error: "Invalid stage." };
  }

  const supabase = await createClient();
  const { data: existing } = await supabase
    .from("opportunities")
    .select("id, name, stage, contact_id")
    .eq("id", id)
    .eq("tenant_id", tenant.tenantId)
    .maybeSingle();

  if (!existing) {
    return { ok: false, error: "Opportunity not found." };
  }

  if (existing.stage === stage) {
    return { ok: true, id };
  }

  const { error } = await supabase
    .from("opportunities")
    .update({ stage })
    .eq("id", id)
    .eq("tenant_id", tenant.tenantId);

  if (error) {
    return { ok: false, error: error.message };
  }

  await logContactActivity(supabase, {
    tenantId: tenant.tenantId,
    contactId: existing.contact_id,
    activityType: "opportunity",
    title: `Updated opportunity: ${existing.name}`,
    body: `Stage ${formatOpportunityStageLabel(existing.stage)} → ${formatOpportunityStageLabel(stage)}`,
  });

  revalidatePath("/opportunities");
  if (existing.contact_id) {
    revalidatePath(`/leads/${existing.contact_id}`);
    revalidatePath(`/contacts/${existing.contact_id}`);
  }
  return { ok: true, id };
}

export async function createTaskAction(formData: FormData): Promise<CrmActionResult> {
  const tenant = await requireTenantId();
  if (!("tenantId" in tenant)) return tenant;

  const title = String(formData.get("title") ?? "").trim();
  const contactId = parseOptionalContactId(formData.get("contactId"));
  const dueDate = String(formData.get("dueDate") ?? "").trim();
  const notes = String(formData.get("notes") ?? "").trim() || null;

  if (!title) {
    return { ok: false, error: "Task title is required." };
  }

  const dueAt = dueDate ? new Date(`${dueDate}T12:00:00`).toISOString() : null;

  const supabase = await createClient();

  if (contactId) {
    const { data: contact } = await supabase
      .from("contacts")
      .select("id")
      .eq("id", contactId)
      .eq("tenant_id", tenant.tenantId)
      .maybeSingle();
    if (!contact) {
      return { ok: false, error: "Selected lead was not found." };
    }
  }

  const { data: task, error } = await supabase
    .from("tasks")
    .insert({
      tenant_id: tenant.tenantId,
      contact_id: contactId,
      title,
      status: "open",
      due_at: dueAt,
      notes,
    })
    .select("id")
    .single();

  if (error || !task) {
    return { ok: false, error: error?.message ?? "Could not create task." };
  }

  revalidatePath("/tasks");
  if (contactId) {
    revalidatePath(`/leads/${contactId}`);
    revalidatePath(`/contacts/${contactId}`);
  }
  return { ok: true, id: task.id };
}

export async function createActivityAction(formData: FormData): Promise<CrmActionResult> {
  const tenant = await requireTenantId();
  if (!("tenantId" in tenant)) return tenant;

  const contactId = parseOptionalContactId(formData.get("contactId"));
  const activityTypeRaw = String(formData.get("activityType") ?? "").trim();
  const title = String(formData.get("title") ?? "").trim();
  const body = String(formData.get("body") ?? "").trim() || null;
  const occurredDate = String(formData.get("occurredDate") ?? "").trim();

  if (!contactId) {
    return { ok: false, error: "A contact is required." };
  }
  if (!isActivityType(activityTypeRaw)) {
    return { ok: false, error: "Select an activity type." };
  }
  if (!title) {
    return { ok: false, error: "Activity title is required." };
  }

  const occurredAt = occurredDate
    ? new Date(`${occurredDate}T12:00:00`).toISOString()
    : new Date().toISOString();

  const supabase = await createClient();
  const { data: contact } = await supabase
    .from("contacts")
    .select("id, record_type")
    .eq("id", contactId)
    .eq("tenant_id", tenant.tenantId)
    .maybeSingle();

  if (!contact) {
    return { ok: false, error: "Selected contact was not found." };
  }

  const { data: activity, error } = await supabase
    .from("contact_activities")
    .insert({
      tenant_id: tenant.tenantId,
      contact_id: contactId,
      activity_type: activityTypeRaw,
      title,
      body,
      occurred_at: occurredAt,
    })
    .select("id")
    .single();

  if (error || !activity) {
    return { ok: false, error: error?.message ?? "Could not create activity." };
  }

  revalidatePath(`/leads/${contactId}`);
  revalidatePath(`/contacts/${contactId}`);
  return { ok: true, id: activity.id };
}

