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
import { isActivityType, type ActivityRelatedEntityType, type StoredActivityType } from "@/lib/crm/person-activities";
import { parsePhoneForStorage } from "@/lib/phone-display";
import { resolveCurrentTenant } from "@/lib/tenant/current-tenant";
import { createClient } from "@/lib/supabase/server";
import {
  createUserNotification,
  notifyTenantNewLead,
} from "@/lib/notifications/create-notification";
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

async function currentUserId(): Promise<string | null> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  return user?.id ?? null;
}

async function notifySelf(input: {
  tenantId: string;
  category: "tasks" | "leads" | "opportunities" | "messages" | "system";
  title: string;
  body?: string | null;
  href?: string | null;
}): Promise<void> {
  const userId = await currentUserId();
  if (!userId) return;
  await createUserNotification({
    userId,
    tenantId: input.tenantId,
    category: input.category,
    title: input.title,
    body: input.body,
    href: input.href,
  });
  revalidatePath("/", "layout");
  revalidatePath("/admin", "layout");
}

function parseOptionalContactId(value: FormDataEntryValue | null): string | null {
  const raw = String(value ?? "").trim();
  if (!raw || raw === "none") return null;
  return raw;
}

function isMissingTaskScheduleColumnError(message: string): boolean {
  return /Could not find the '(start_at|end_at)' column|column ["']?(start_at|end_at)["']?.*(does not exist|not found)|schema cache.*\b(start_at|end_at)\b/i.test(
    message,
  );
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
    relatedEntityType?: ActivityRelatedEntityType | null;
    relatedEntityId?: string | null;
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
    related_entity_type: params.relatedEntityType ?? null,
    related_entity_id: params.relatedEntityId ?? null,
  };

  let { error } = await supabase.from("contact_activities").insert(payload);

  const withoutRelated = () => {
    const { related_entity_type: _t, related_entity_id: _i, ...legacy } = payload;
    return legacy;
  };

  if (error && /related_entity|schema cache|column/i.test(error.message)) {
    ({ error } = await supabase.from("contact_activities").insert(withoutRelated()));
  }

  if (error && /activity_type|check constraint/i.test(error.message)) {
    const asOther = { ...payload, activity_type: "other" as const };
    ({ error } = await supabase.from("contact_activities").insert(asOther));
    if (error && /related_entity|schema cache|column/i.test(error.message)) {
      const { related_entity_type: _t, related_entity_id: _i, ...legacy } = asOther;
      ({ error } = await supabase.from("contact_activities").insert(legacy));
    }
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
    relatedEntityType: kind,
    relatedEntityId: contact.id,
  });

  if (kind === "lead") {
    await notifyTenantNewLead({
      tenantId: tenant.tenantId,
      contactId: contact.id,
      firstName,
      lastName,
    });
    revalidatePath("/", "layout");
  } else {
    await notifySelf({
      tenantId: tenant.tenantId,
      category: "leads",
      title: `Contact created: ${createdName}`,
      body: contactType ? `Type ${formatContactTypeLabel(contactType)}` : null,
      href: `${personBasePath(kind)}/${contact.id}`,
    });
  }

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
      relatedEntityType: nextKind,
      relatedEntityId: leadId,
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
    relatedEntityType: nextKind,
    relatedEntityId: id,
  });

  await notifySelf({
    tenantId: tenant.tenantId,
    category: "leads",
    title: `Lead status updated: ${personDisplayName(existing.first_name, existing.last_name)}`,
    body: `${formatLeadStatusLabel(existing.lead_status ?? "")} → ${formatLeadStatusLabel(status)}`,
    href: `${personBasePath(nextKind)}/${id}`,
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
    relatedEntityType: "contact",
    relatedEntityId: id,
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
    title: "New Opportunity",
    body: [
      typeof amount === "number"
        ? `${name} → ${formatUsdCents(amount)} ${opportunityType} Opportunity`
        : `${name} · ${opportunityType} Opportunity`,
      `Stage ${formatOpportunityStageLabel(stage)}`,
    ].join(" · "),
    relatedEntityType: "opportunity",
    relatedEntityId: opportunity.id,
  });

  await notifySelf({
    tenantId: tenant.tenantId,
    category: "opportunities",
    title: `Opportunity created: ${name}`,
    body: `Stage ${formatOpportunityStageLabel(stage)}`,
    href: `/opportunities/${opportunity.id}`,
  });

  revalidatePath("/opportunities");
  revalidatePath(`/opportunities/${opportunity.id}`);
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
    const stageChange = existing.stage !== stage;
    const valueChange =
      (existing.amount_cents ?? null) !== (typeof amount === "number" ? amount : null);
    const ownerChange =
      (existing.assigned_agent_id ?? null) !== assignedAgentId;

    let title = `Opportunity updated: ${name}`;
    if (stageChange && changes.length === 1) title = "Opportunity stage changed";
    else if (valueChange && changes.length === 1) title = "Opportunity value changed";
    else if (ownerChange && changes.length === 1) title = "Opportunity owner changed";
    else if (stageChange) title = "Opportunity stage changed";

    await logContactActivity(supabase, {
      tenantId: tenant.tenantId,
      contactId,
      activityType: "opportunity",
      title,
      body: changes.join(" · "),
      relatedEntityType: "opportunity",
      relatedEntityId: id,
    });
    if (existing.contact_id && existing.contact_id !== contactId) {
      await logContactActivity(supabase, {
        tenantId: tenant.tenantId,
        contactId: existing.contact_id,
        activityType: "opportunity",
        title: `Unlinked opportunity: ${existing.name}`,
        body: `Moved to another contact`,
        relatedEntityType: "opportunity",
        relatedEntityId: id,
      });
    }

    if (existing.stage !== stage) {
      await notifySelf({
        tenantId: tenant.tenantId,
        category: "opportunities",
        title: `Stage updated: ${name}`,
        body: `${formatOpportunityStageLabel(existing.stage)} → ${formatOpportunityStageLabel(stage)}`,
        href: `/opportunities/${id}`,
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
      relatedEntityType: "opportunity",
      relatedEntityId: row.id,
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
    title: "Opportunity stage changed",
    body: `${existing.name}: ${formatOpportunityStageLabel(existing.stage)} → ${formatOpportunityStageLabel(stage)}`,
    relatedEntityType: "opportunity",
    relatedEntityId: id,
  });

  await notifySelf({
    tenantId: tenant.tenantId,
    category: "opportunities",
    title: `Stage updated: ${existing.name}`,
    body: `${formatOpportunityStageLabel(existing.stage)} → ${formatOpportunityStageLabel(stage)}`,
    href: `/opportunities/${id}`,
  });

  revalidatePath("/opportunities");
  revalidatePath(`/opportunities/${id}`);
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
  const opportunityIdRaw = String(formData.get("opportunityId") ?? "").trim();
  const opportunityId = opportunityIdRaw || null;
  const dueDate = String(formData.get("dueDate") ?? "").trim();
  const startDate = String(formData.get("startDate") ?? "").trim();
  const startTime = String(formData.get("startTime") ?? "").trim();
  const endDate = String(formData.get("endDate") ?? "").trim();
  const endTime = String(formData.get("endTime") ?? "").trim();
  const notes = String(formData.get("notes") ?? "").trim() || null;

  if (!title) {
    return { ok: false, error: "Task title is required." };
  }

  const dueAt = dueDate ? new Date(`${dueDate}T12:00:00`).toISOString() : null;

  function combineDateAndTime(date: string, time: string): string | null {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;
    const clock = /^\d{2}:\d{2}$/.test(time) ? time : "00:00";
    const value = new Date(`${date}T${clock}:00`);
    if (Number.isNaN(value.getTime())) return null;
    return value.toISOString();
  }

  if (startTime && !startDate) {
    return { ok: false, error: "Select a start date for the start time." };
  }
  if (endTime && !endDate) {
    return { ok: false, error: "Select an end date for the end time." };
  }

  const startAt = combineDateAndTime(startDate, startTime);
  const endAt = combineDateAndTime(endDate, endTime);

  if (startAt && endAt && new Date(endAt).getTime() < new Date(startAt).getTime()) {
    return { ok: false, error: "End must be after start." };
  }

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

  if (opportunityId) {
    const { data: opportunity } = await supabase
      .from("opportunities")
      .select("id")
      .eq("id", opportunityId)
      .eq("tenant_id", tenant.tenantId)
      .maybeSingle();
    if (!opportunity) {
      return { ok: false, error: "Selected opportunity was not found." };
    }
  }

  const payload = {
    tenant_id: tenant.tenantId,
    contact_id: contactId,
    opportunity_id: opportunityId,
    title,
    status: "open" as const,
    due_at: dueAt,
    start_at: startAt,
    end_at: endAt,
    notes,
  };

  let { data: task, error } = await supabase
    .from("tasks")
    .insert(payload)
    .select("id")
    .single();

  if (error && isMissingTaskScheduleColumnError(error.message)) {
    const { start_at: _s, end_at: _e, ...legacyPayload } = payload;
    if (startAt || endAt) {
      return {
        ok: false,
        error:
          "Start/end columns are missing. Run migration 030_tasks_start_end_time.sql in Supabase, then try again.",
      };
    }
    ({ data: task, error } = await supabase
      .from("tasks")
      .insert(legacyPayload)
      .select("id")
      .single());
  }

  if (error || !task) {
    return { ok: false, error: error?.message ?? "Could not create task." };
  }

  await notifySelf({
    tenantId: tenant.tenantId,
    category: "tasks",
    title: `Task created: ${title}`,
    body: dueAt
      ? `Due ${new Intl.DateTimeFormat("en-US", {
          month: "short",
          day: "numeric",
          year: "numeric",
        }).format(new Date(dueAt))}`
      : "Added to your tasks",
    href: "/tasks",
  });

  revalidatePath("/tasks");
  if (opportunityId) {
    revalidatePath(`/opportunities/${opportunityId}`);
  }
  if (contactId) {
    revalidatePath(`/leads/${contactId}`);
    revalidatePath(`/contacts/${contactId}`);
  }
  return { ok: true, id: task.id };
}

export async function updateTaskStatusAction(
  taskId: string,
  status: "open" | "done",
): Promise<CrmActionResult> {
  const tenant = await requireTenantId();
  if (!("tenantId" in tenant)) return tenant;

  const id = taskId.trim();
  if (!id) {
    return { ok: false, error: "Task is required." };
  }

  const supabase = await createClient();
  const { data: existing, error: loadError } = await supabase
    .from("tasks")
    .select("id, title, contact_id, opportunity_id, status")
    .eq("id", id)
    .eq("tenant_id", tenant.tenantId)
    .maybeSingle();

  if (loadError || !existing) {
    return { ok: false, error: loadError?.message ?? "Task was not found." };
  }

  if (existing.status === status) {
    return { ok: true, id };
  }

  const { error } = await supabase
    .from("tasks")
    .update({ status })
    .eq("id", id)
    .eq("tenant_id", tenant.tenantId);

  if (error) {
    return { ok: false, error: error.message };
  }

  await notifySelf({
    tenantId: tenant.tenantId,
    category: "tasks",
    title:
      status === "done"
        ? `Task completed: ${existing.title}`
        : `Task reopened: ${existing.title}`,
    body: status === "done" ? "Marked as done" : "Moved back to upcoming",
    href: "/tasks",
  });

  revalidatePath("/tasks");
  if (existing.opportunity_id) {
    revalidatePath(`/opportunities/${existing.opportunity_id}`);
  }
  if (existing.contact_id) {
    revalidatePath(`/leads/${existing.contact_id}`);
    revalidatePath(`/contacts/${existing.contact_id}`);
  }
  return { ok: true, id };
}

export async function updateTaskAction(formData: FormData): Promise<CrmActionResult> {
  const tenant = await requireTenantId();
  if (!("tenantId" in tenant)) return tenant;

  const id = String(formData.get("taskId") ?? "").trim();
  const title = String(formData.get("title") ?? "").trim();
  const dueDate = String(formData.get("dueDate") ?? "").trim();
  const startDate = String(formData.get("startDate") ?? "").trim();
  const startTime = String(formData.get("startTime") ?? "").trim();
  const endDate = String(formData.get("endDate") ?? "").trim();
  const endTime = String(formData.get("endTime") ?? "").trim();
  const notes = String(formData.get("notes") ?? "").trim() || null;
  const statusRaw = String(formData.get("status") ?? "").trim();
  const status = statusRaw === "done" || statusRaw === "open" ? statusRaw : null;

  if (!id) {
    return { ok: false, error: "Task is required." };
  }
  if (!title) {
    return { ok: false, error: "Task title is required." };
  }

  function combineDateAndTime(date: string, time: string): string | null {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;
    const clock = /^\d{2}:\d{2}$/.test(time) ? time : "00:00";
    const value = new Date(`${date}T${clock}:00`);
    if (Number.isNaN(value.getTime())) return null;
    return value.toISOString();
  }

  if (startTime && !startDate) {
    return { ok: false, error: "Select a start date for the start time." };
  }
  if (endTime && !endDate) {
    return { ok: false, error: "Select an end date for the end time." };
  }

  const dueAt = dueDate ? new Date(`${dueDate}T12:00:00`).toISOString() : null;
  const startAt = combineDateAndTime(startDate, startTime);
  const endAt = combineDateAndTime(endDate, endTime);

  if (startAt && endAt && new Date(endAt).getTime() < new Date(startAt).getTime()) {
    return { ok: false, error: "End must be after start." };
  }

  const supabase = await createClient();
  const { data: existing, error: loadError } = await supabase
    .from("tasks")
    .select("id, contact_id, opportunity_id, status")
    .eq("id", id)
    .eq("tenant_id", tenant.tenantId)
    .maybeSingle();

  if (loadError || !existing) {
    return { ok: false, error: loadError?.message ?? "Task was not found." };
  }

  const payload: Record<string, unknown> = {
    title,
    due_at: dueAt,
    start_at: startAt,
    end_at: endAt,
    notes,
  };
  if (status) {
    payload.status = status;
  }

  let { error } = await supabase
    .from("tasks")
    .update(payload)
    .eq("id", id)
    .eq("tenant_id", tenant.tenantId);

  if (error && isMissingTaskScheduleColumnError(error.message)) {
    if (startAt || endAt) {
      return {
        ok: false,
        error:
          "Start/end columns are missing. Run migration 030_tasks_start_end_time.sql in Supabase, then try again.",
      };
    }
    const { start_at: _s, end_at: _e, ...legacyPayload } = payload;
    ({ error } = await supabase
      .from("tasks")
      .update(legacyPayload)
      .eq("id", id)
      .eq("tenant_id", tenant.tenantId));
  }

  if (error) {
    return { ok: false, error: error.message };
  }

  const statusChanged = Boolean(status && status !== existing.status);
  if (statusChanged && status) {
    await notifySelf({
      tenantId: tenant.tenantId,
      category: "tasks",
      title:
        status === "done" ? `Task completed: ${title}` : `Task reopened: ${title}`,
      body: status === "done" ? "Marked as done" : "Moved back to upcoming",
      href: "/tasks",
    });
  }

  revalidatePath("/tasks");
  if (existing.opportunity_id) {
    revalidatePath(`/opportunities/${existing.opportunity_id}`);
  }
  if (existing.contact_id) {
    revalidatePath(`/leads/${existing.contact_id}`);
    revalidatePath(`/contacts/${existing.contact_id}`);
  }
  return { ok: true, id };
}

export async function createActivityAction(formData: FormData): Promise<CrmActionResult> {
  const tenant = await requireTenantId();
  if (!("tenantId" in tenant)) return tenant;

  const contactId = parseOptionalContactId(formData.get("contactId"));
  const opportunityIdRaw = String(formData.get("opportunityId") ?? "").trim();
  const opportunityId = opportunityIdRaw || null;
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

  // Notes always use the current system time; other activities may pick a date.
  const occurredAt =
    activityTypeRaw === "note"
      ? new Date().toISOString()
      : occurredDate
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

  if (opportunityId) {
    const { data: opportunity } = await supabase
      .from("opportunities")
      .select("id")
      .eq("id", opportunityId)
      .eq("tenant_id", tenant.tenantId)
      .maybeSingle();
    if (!opportunity) {
      return { ok: false, error: "Selected opportunity was not found." };
    }
  }

  const relatedEntityType: ActivityRelatedEntityType = opportunityId
    ? "opportunity"
    : contact.record_type === "contact"
      ? "contact"
      : "lead";
  const relatedEntityId = opportunityId ?? contactId;

  const payload = {
    tenant_id: tenant.tenantId,
    contact_id: contactId,
    activity_type: activityTypeRaw,
    title,
    body,
    occurred_at: occurredAt,
    related_entity_type: relatedEntityType,
    related_entity_id: relatedEntityId,
  };

  let { data: activity, error } = await supabase
    .from("contact_activities")
    .insert(payload)
    .select("id")
    .single();

  if (error && /related_entity|schema cache|column/i.test(error.message)) {
    const { related_entity_type: _t, related_entity_id: _i, ...legacyPayload } = payload;
    ({ data: activity, error } = await supabase
      .from("contact_activities")
      .insert(legacyPayload)
      .select("id")
      .single());
  }

  if (error || !activity) {
    return { ok: false, error: error?.message ?? "Could not create activity." };
  }

  revalidatePath(`/leads/${contactId}`);
  revalidatePath(`/contacts/${contactId}`);
  if (opportunityId) {
    revalidatePath(`/opportunities/${opportunityId}`);
  }
  return { ok: true, id: activity.id };
}

export async function updateActivityAction(formData: FormData): Promise<CrmActionResult> {
  const tenant = await requireTenantId();
  if (!("tenantId" in tenant)) return tenant;

  const activityId = String(formData.get("activityId") ?? "").trim();
  const title = String(formData.get("title") ?? "").trim();
  const body = String(formData.get("body") ?? "").trim() || null;

  if (!activityId) {
    return { ok: false, error: "Activity is required." };
  }
  if (!title) {
    return { ok: false, error: "Note title is required." };
  }

  const supabase = await createClient();
  let existing: {
    id: string;
    contact_id: string;
    related_entity_type?: string | null;
    related_entity_id?: string | null;
  } | null = null;

  const withRelated = await supabase
    .from("contact_activities")
    .select("id, contact_id, related_entity_type, related_entity_id")
    .eq("id", activityId)
    .eq("tenant_id", tenant.tenantId)
    .maybeSingle();

  if (withRelated.error && /related_entity|schema cache|column/i.test(withRelated.error.message)) {
    const legacy = await supabase
      .from("contact_activities")
      .select("id, contact_id")
      .eq("id", activityId)
      .eq("tenant_id", tenant.tenantId)
      .maybeSingle();
    if (legacy.error || !legacy.data) {
      return { ok: false, error: legacy.error?.message ?? "Note was not found." };
    }
    existing = legacy.data;
  } else if (withRelated.error || !withRelated.data) {
    return { ok: false, error: withRelated.error?.message ?? "Note was not found." };
  } else {
    existing = withRelated.data;
  }

  const { error } = await supabase
    .from("contact_activities")
    .update({
      title,
      body,
    })
    .eq("id", activityId)
    .eq("tenant_id", tenant.tenantId);

  if (error) {
    return { ok: false, error: error.message };
  }

  revalidatePath(`/leads/${existing.contact_id}`);
  revalidatePath(`/contacts/${existing.contact_id}`);
  if (
    existing.related_entity_type === "opportunity" &&
    typeof existing.related_entity_id === "string" &&
    existing.related_entity_id
  ) {
    revalidatePath(`/opportunities/${existing.related_entity_id}`);
  }
  return { ok: true, id: activityId };
}

