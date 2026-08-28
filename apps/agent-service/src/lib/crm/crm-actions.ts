"use server";

import { revalidatePath } from "next/cache";
import { isPersonKind, personBasePath, personSingular, type PersonKind } from "@/lib/crm/person-kind";
import { isLeadStatus } from "@/lib/leads/lead-status";
import { parsePhoneForStorage } from "@/lib/phone-display";
import { resolveCurrentTenant } from "@/lib/tenant/current-tenant";
import { createClient } from "@/lib/supabase/server";

export interface CrmActionResult {
  ok: boolean;
  error?: string;
  id?: string;
}

const OPPORTUNITY_STAGES = [
  "Qualification",
  "Proposal",
  "Negotiation",
  "Closed_Won",
  "Closed_Lost",
] as const;

type OpportunityStage = (typeof OPPORTUNITY_STAGES)[number];

function isOpportunityStage(value: string): value is OpportunityStage {
  return (OPPORTUNITY_STAGES as readonly string[]).includes(value);
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
      lead_status: status,
      record_type: kind,
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
  const status = isLeadStatus(statusRaw) ? statusRaw : "New";

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
    .select("id, record_type")
    .eq("id", leadId)
    .eq("tenant_id", tenant.tenantId)
    .maybeSingle();

  if (!existing) {
    return { ok: false, error: "Record not found." };
  }

  const kind: PersonKind = existing.record_type === "contact" ? "contact" : "lead";
  const label = personSingular(kind);

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
    .update({
      first_name: firstName || null,
      last_name: lastName || null,
      email: email || null,
      lead_status: status,
    })
    .eq("id", leadId)
    .eq("tenant_id", tenant.tenantId);

  if (contactError) {
    return { ok: false, error: contactError.message };
  }

  const { data: smsIdentity } = await supabase
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

  revalidatePersonPaths(kind, leadId);
  return { ok: true, id: leadId };
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
    .select("id, record_type")
    .eq("id", id)
    .eq("tenant_id", tenant.tenantId)
    .maybeSingle();

  if (!existing) {
    return { ok: false, error: "Record not found." };
  }

  const kind: PersonKind = existing.record_type === "contact" ? "contact" : "lead";
  const { error } = await supabase
    .from("contacts")
    .update({ lead_status: status })
    .eq("id", id)
    .eq("tenant_id", tenant.tenantId);

  if (error) {
    return { ok: false, error: error.message };
  }

  revalidatePersonPaths(kind, id);
  return { ok: true, id };
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
  const stageRaw = String(formData.get("stage") ?? "Qualification");
  const stage = isOpportunityStage(stageRaw) ? stageRaw : "Qualification";
  const contactId = parseOptionalContactId(formData.get("contactId"));
  const expectedCloseDate = String(formData.get("expectedCloseDate") ?? "").trim() || null;
  const notes = String(formData.get("notes") ?? "").trim() || null;
  const amount = parseAmountCents(formData.get("amount"));

  if (!name) {
    return { ok: false, error: "Opportunity name is required." };
  }
  if (amount && typeof amount === "object" && "error" in amount) {
    return { ok: false, error: amount.error };
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

  const { data: opportunity, error } = await supabase
    .from("opportunities")
    .insert({
      tenant_id: tenant.tenantId,
      contact_id: contactId,
      name,
      stage,
      amount_cents: typeof amount === "number" ? amount : null,
      expected_close_date: expectedCloseDate,
      notes,
    })
    .select("id")
    .single();

  if (error || !opportunity) {
    return { ok: false, error: error?.message ?? "Could not create opportunity." };
  }

  revalidatePath("/opportunities");
  return { ok: true, id: opportunity.id };
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
  return { ok: true, id: task.id };
}

