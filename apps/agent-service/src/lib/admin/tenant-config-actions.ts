"use server";

import { revalidatePath } from "next/cache";
import { requirePlatformAdmin } from "@/lib/admin/auth";
import { slugify } from "@/lib/admin/slug";
import { createClient } from "@/lib/supabase/server";
import { isValidTenantStatus } from "@/lib/admin/account-status";
import { parsePhoneForStorage } from "@/lib/phone-display";

export interface ActionResult {
  ok: boolean;
  error?: string;
}

function revalidateTenant(tenantId: string) {
  revalidatePath("/admin");
  revalidatePath(`/admin/accounts/${tenantId}`);
}

function readCheckbox(formData: FormData, name: string): boolean {
  return formData.get(name) === "on";
}

function readTenantId(formData: FormData): string | null {
  const tenantId = String(formData.get("tenantId") ?? "").trim();
  return tenantId || null;
}

async function markTenantModified(tenantId: string, userId: string): Promise<ActionResult> {
  const supabase = await createClient();
  const { error } = await supabase
    .from("tenants")
    .update({ last_modified_by_id: userId })
    .eq("id", tenantId);

  if (error) return { ok: false, error: error.message };
  return { ok: true };
}

async function saveTenantPrimaryPhone(
  tenantId: string,
  phoneRaw: string,
): Promise<ActionResult> {
  const supabase = await createClient();

  const { data: existing } = await supabase
    .from("tenant_phone_numbers")
    .select("id")
    .eq("tenant_id", tenantId)
    .eq("is_primary", true)
    .maybeSingle();

  if (!phoneRaw) {
    if (existing) {
      const { error } = await supabase
        .from("tenant_phone_numbers")
        .delete()
        .eq("id", existing.id);
      if (error) return { ok: false, error: error.message };
    }
    return { ok: true };
  }

  const phoneResult = parsePhoneForStorage(phoneRaw);
  if (!phoneResult.ok) return { ok: false, error: phoneResult.error };
  const phone = phoneResult.phone;
  if (!phone) return { ok: true };

  if (existing) {
    const { error } = await supabase
      .from("tenant_phone_numbers")
      .update({ phone_e164: phone })
      .eq("id", existing.id);

    if (error) {
      if (error.code === "23505") {
        return { ok: false, error: "That phone number is already assigned." };
      }
      return { ok: false, error: error.message };
    }
  } else {
    const { error } = await supabase.from("tenant_phone_numbers").insert({
      tenant_id: tenantId,
      phone_e164: phone,
      is_primary: true,
    });

    if (error) {
      if (error.code === "23505") {
        return { ok: false, error: "That phone number is already assigned." };
      }
      return { ok: false, error: error.message };
    }
  }

  return { ok: true };
}

export async function updateTenantHighlightsAction(formData: FormData): Promise<ActionResult> {
  const admin = await requirePlatformAdmin();

  const tenantId = readTenantId(formData);
  if (!tenantId) return { ok: false, error: "Missing account id." };

  const accountType = String(formData.get("accountType") ?? "").trim() || "Tenant";
  const website = String(formData.get("website") ?? "").trim() || null;
  const industry = String(formData.get("industry") ?? "").trim() || null;
  const accountOwnerId = String(formData.get("accountOwnerId") ?? "").trim() || null;
  const phone = String(formData.get("phoneE164") ?? "").trim();

  const supabase = await createClient();
  const { error } = await supabase
    .from("tenants")
    .update({
      account_type: accountType,
      website,
      industry,
      account_owner_id: accountOwnerId,
      last_modified_by_id: admin.id,
    })
    .eq("id", tenantId);

  if (error) return { ok: false, error: error.message };

  const phoneResult = await saveTenantPrimaryPhone(tenantId, phone);
  if (!phoneResult.ok) return phoneResult;

  revalidateTenant(tenantId);
  return { ok: true };
}

export async function updateTenantContactAction(formData: FormData): Promise<ActionResult> {
  const admin = await requirePlatformAdmin();

  const tenantId = readTenantId(formData);
  if (!tenantId) return { ok: false, error: "Missing account id." };

  const principalFirstName = String(formData.get("principalFirstName") ?? "").trim();
  const principalLastName = String(formData.get("principalLastName") ?? "").trim();
  const email = String(formData.get("email") ?? "").trim() || null;
  const website = String(formData.get("website") ?? "").trim() || null;
  const phone = String(formData.get("phoneE164") ?? "").trim();

  if (!principalFirstName || !principalLastName) {
    return { ok: false, error: "First and last name are required." };
  }

  const supabase = await createClient();
  const { error } = await supabase
    .from("tenants")
    .update({
      principal_first_name: principalFirstName,
      principal_last_name: principalLastName,
      email,
      website,
      last_modified_by_id: admin.id,
    })
    .eq("id", tenantId);

  if (error) return { ok: false, error: error.message };

  const phoneResult = await saveTenantPrimaryPhone(tenantId, phone);
  if (!phoneResult.ok) return phoneResult;

  revalidateTenant(tenantId);
  return { ok: true };
}

export async function createTenantAdditionalContactAction(
  formData: FormData,
): Promise<ActionResult> {
  const admin = await requirePlatformAdmin();

  const tenantId = readTenantId(formData);
  if (!tenantId) return { ok: false, error: "Missing account id." };

  const firstName = String(formData.get("firstName") ?? "").trim();
  const lastName = String(formData.get("lastName") ?? "").trim();
  const email = String(formData.get("email") ?? "").trim() || null;
  const website = String(formData.get("website") ?? "").trim() || null;
  const phoneRaw = String(formData.get("phoneE164") ?? "").trim();
  const title = String(formData.get("title") ?? "").trim() || null;

  if (!firstName || !lastName) {
    return { ok: false, error: "First and last name are required." };
  }

  const phoneResult = parsePhoneForStorage(phoneRaw);
  if (!phoneResult.ok) return { ok: false, error: phoneResult.error };
  const phoneE164 = phoneResult.phone;

  const supabase = await createClient();
  const { error } = await supabase.from("tenant_contacts").insert({
    tenant_id: tenantId,
    first_name: firstName,
    last_name: lastName,
    email,
    phone_e164: phoneE164,
    website,
    title,
  });

  if (error) return { ok: false, error: error.message };

  const auditResult = await markTenantModified(tenantId, admin.id);
  if (!auditResult.ok) return auditResult;

  revalidateTenant(tenantId);
  return { ok: true };
}

export async function updateTenantAdditionalContactAction(
  formData: FormData,
): Promise<ActionResult> {
  const admin = await requirePlatformAdmin();

  const tenantId = readTenantId(formData);
  const contactId = String(formData.get("contactId") ?? "").trim();
  if (!tenantId || !contactId) return { ok: false, error: "Missing account or contact id." };

  const firstName = String(formData.get("firstName") ?? "").trim();
  const lastName = String(formData.get("lastName") ?? "").trim();
  const email = String(formData.get("email") ?? "").trim() || null;
  const website = String(formData.get("website") ?? "").trim() || null;
  const phoneRaw = String(formData.get("phoneE164") ?? "").trim();
  const title = String(formData.get("title") ?? "").trim() || null;

  if (!firstName || !lastName) {
    return { ok: false, error: "First and last name are required." };
  }

  const phoneResult = parsePhoneForStorage(phoneRaw);
  if (!phoneResult.ok) return { ok: false, error: phoneResult.error };
  const phoneE164 = phoneResult.phone;

  const supabase = await createClient();
  const { error } = await supabase
    .from("tenant_contacts")
    .update({
      first_name: firstName,
      last_name: lastName,
      email,
      phone_e164: phoneE164,
      website,
      title,
    })
    .eq("id", contactId)
    .eq("tenant_id", tenantId);

  if (error) return { ok: false, error: error.message };

  const auditResult = await markTenantModified(tenantId, admin.id);
  if (!auditResult.ok) return auditResult;

  revalidateTenant(tenantId);
  return { ok: true };
}

export async function updateTenantAccountInfoAction(formData: FormData): Promise<ActionResult> {
  const admin = await requirePlatformAdmin();

  const tenantId = readTenantId(formData);
  if (!tenantId) return { ok: false, error: "Missing account id." };

  const name = String(formData.get("name") ?? "").trim();
  const slugInput = String(formData.get("slug") ?? "").trim();
  const slug = (slugInput || slugify(name)).toLowerCase();
  const timezone = String(formData.get("timezone") ?? "America/New_York").trim();
  const status = String(formData.get("status") ?? "company_info").trim();

  if (!name || !slug) {
    return { ok: false, error: "Realtor name and account name are required." };
  }

  if (!isValidTenantStatus(status)) {
    return { ok: false, error: "Invalid status." };
  }

  const supabase = await createClient();
  const { error } = await supabase
    .from("tenants")
    .update({ name, slug, timezone, status, last_modified_by_id: admin.id })
    .eq("id", tenantId);

  if (error) {
    if (error.code === "23505") {
      return { ok: false, error: "That account name is already in use." };
    }
    return { ok: false, error: error.message };
  }

  revalidateTenant(tenantId);
  return { ok: true };
}

export async function updateTenantAddressAction(formData: FormData): Promise<ActionResult> {
  const admin = await requirePlatformAdmin();

  const tenantId = readTenantId(formData);
  if (!tenantId) return { ok: false, error: "Missing account id." };

  const street = String(formData.get("street") ?? "").trim() || null;
  const city = String(formData.get("city") ?? "").trim() || null;
  const state = String(formData.get("state") ?? "").trim() || null;
  const postalCode = String(formData.get("postalCode") ?? "").trim() || null;
  const country = String(formData.get("country") ?? "").trim() || null;

  const supabase = await createClient();
  const { error } = await supabase
    .from("tenants")
    .update({
      street,
      city,
      state,
      postal_code: postalCode,
      country,
      last_modified_by_id: admin.id,
    })
    .eq("id", tenantId);

  if (error) return { ok: false, error: error.message };

  revalidateTenant(tenantId);
  return { ok: true };
}

export async function updateTenantDetailsAction(formData: FormData): Promise<ActionResult> {
  const admin = await requirePlatformAdmin();

  const tenantId = readTenantId(formData);
  if (!tenantId) return { ok: false, error: "Missing account id." };

  const name = String(formData.get("name") ?? "").trim();
  const slugInput = String(formData.get("slug") ?? "").trim();
  const slug = (slugInput || slugify(name)).toLowerCase();
  const street = String(formData.get("street") ?? "").trim() || null;
  const city = String(formData.get("city") ?? "").trim() || null;
  const state = String(formData.get("state") ?? "").trim() || null;
  const postalCode = String(formData.get("postalCode") ?? "").trim() || null;
  const country = String(formData.get("country") ?? "").trim() || null;
  const timezone = String(formData.get("timezone") ?? "America/New_York").trim();

  if (!name || !slug) {
    return { ok: false, error: "Realtor name and account name are required." };
  }

  const supabase = await createClient();
  const { error } = await supabase
    .from("tenants")
    .update({
      name,
      slug,
      street,
      city,
      state,
      postal_code: postalCode,
      country,
      timezone,
      last_modified_by_id: admin.id,
    })
    .eq("id", tenantId);

  if (error) {
    if (error.code === "23505") {
      return { ok: false, error: "That account name is already in use." };
    }
    return { ok: false, error: error.message };
  }

  revalidateTenant(tenantId);
  return { ok: true };
}

export async function updateTenantProfileAction(formData: FormData): Promise<ActionResult> {
  const admin = await requirePlatformAdmin();

  const tenantId = readTenantId(formData);
  if (!tenantId) return { ok: false, error: "Missing account id." };

  const name = String(formData.get("name") ?? "").trim();
  const slugInput = String(formData.get("slug") ?? "").trim();
  const slug = (slugInput || slugify(name)).toLowerCase();
  const principalFirstName = String(formData.get("principalFirstName") ?? "").trim();
  const principalLastName = String(formData.get("principalLastName") ?? "").trim();
  const timezone = String(formData.get("timezone") ?? "America/New_York").trim();
  const status = String(formData.get("status") ?? "company_info").trim();

  if (!name || !slug || !principalFirstName || !principalLastName) {
    return { ok: false, error: "Realtor name, account name, and principal name are required." };
  }

  if (!isValidTenantStatus(status)) {
    return { ok: false, error: "Invalid status." };
  }

  const supabase = await createClient();
  const { error } = await supabase
    .from("tenants")
    .update({
      name,
      slug,
      principal_first_name: principalFirstName,
      principal_last_name: principalLastName,
      timezone,
      status,
      last_modified_by_id: admin.id,
    })
    .eq("id", tenantId);

  if (error) {
    if (error.code === "23505") {
      return { ok: false, error: "That account name is already in use." };
    }
    return { ok: false, error: error.message };
  }

  revalidateTenant(tenantId);
  return { ok: true };
}

export async function updateTenantPhoneAction(formData: FormData): Promise<ActionResult> {
  const admin = await requirePlatformAdmin();

  const tenantId = readTenantId(formData);
  if (!tenantId) return { ok: false, error: "Missing account id." };

  const phone = String(formData.get("phoneE164") ?? "").trim();
  const phoneResult = await saveTenantPrimaryPhone(tenantId, phone);
  if (!phoneResult.ok) return phoneResult;

  const auditResult = await markTenantModified(tenantId, admin.id);
  if (!auditResult.ok) return auditResult;

  revalidateTenant(tenantId);
  return { ok: true };
}

export async function updateTenantAgentsAction(formData: FormData): Promise<ActionResult> {
  const admin = await requirePlatformAdmin();

  const tenantId = readTenantId(formData);
  if (!tenantId) return { ok: false, error: "Missing account id." };

  const supabase = await createClient();
  const { error } = await supabase
    .from("tenant_agents")
    .update({
      concierge_enabled: readCheckbox(formData, "conciergeEnabled"),
      scheduler_enabled: readCheckbox(formData, "schedulerEnabled"),
      follow_up_enabled: readCheckbox(formData, "followUpEnabled"),
      intake_enabled: readCheckbox(formData, "intakeEnabled"),
      researcher_enabled: readCheckbox(formData, "researcherEnabled"),
      scout_enabled: readCheckbox(formData, "scoutEnabled"),
    })
    .eq("tenant_id", tenantId);

  if (error) return { ok: false, error: error.message };

  const auditResult = await markTenantModified(tenantId, admin.id);
  if (!auditResult.ok) return auditResult;

  revalidateTenant(tenantId);
  return { ok: true };
}

export async function updateTenantComplianceAction(formData: FormData): Promise<ActionResult> {
  const admin = await requirePlatformAdmin();

  const tenantId = readTenantId(formData);
  if (!tenantId) return { ok: false, error: "Missing account id." };

  const quietHoursStart = String(formData.get("quietHoursStart") ?? "").trim() || null;
  const quietHoursEnd = String(formData.get("quietHoursEnd") ?? "").trim() || null;

  const supabase = await createClient();
  const { error } = await supabase
    .from("tenant_agents")
    .update({
      compliance_strict: readCheckbox(formData, "complianceStrict"),
      quiet_hours_start: quietHoursStart,
      quiet_hours_end: quietHoursEnd,
    })
    .eq("tenant_id", tenantId);

  if (error) return { ok: false, error: error.message };

  const auditResult = await markTenantModified(tenantId, admin.id);
  if (!auditResult.ok) return auditResult;

  revalidateTenant(tenantId);
  return { ok: true };
}

export async function updateTenantBillingAction(formData: FormData): Promise<ActionResult> {
  const admin = await requirePlatformAdmin();

  const tenantId = readTenantId(formData);
  if (!tenantId) return { ok: false, error: "Missing account id." };

  const stripeCustomerId = String(formData.get("stripeCustomerId") ?? "").trim() || null;
  const internalNotes = String(formData.get("internalNotes") ?? "").trim() || null;

  const supabase = await createClient();
  const { error } = await supabase
    .from("tenants")
    .update({
      stripe_customer_id: stripeCustomerId,
      internal_notes: internalNotes,
      last_modified_by_id: admin.id,
    })
    .eq("id", tenantId);

  if (error) return { ok: false, error: error.message };

  revalidateTenant(tenantId);
  return { ok: true };
}

export async function deleteTenantAdditionalContactAction(
  formData: FormData,
): Promise<ActionResult> {
  const admin = await requirePlatformAdmin();

  const tenantId = readTenantId(formData);
  const contactId = String(formData.get("contactId") ?? "").trim();
  if (!tenantId || !contactId) return { ok: false, error: "Missing account or contact id." };

  const supabase = await createClient();
  const { error } = await supabase
    .from("tenant_contacts")
    .delete()
    .eq("id", contactId)
    .eq("tenant_id", tenantId);

  if (error) return { ok: false, error: error.message };

  const auditResult = await markTenantModified(tenantId, admin.id);
  if (!auditResult.ok) return auditResult;

  revalidateTenant(tenantId);
  return { ok: true };
}

export async function disconnectTenantChannelAction(formData: FormData): Promise<ActionResult> {
  const admin = await requirePlatformAdmin();

  const tenantId = readTenantId(formData);
  const channel = String(formData.get("channel") ?? "").trim();
  if (!tenantId) return { ok: false, error: "Missing account id." };
  if (channel !== "messenger" && channel !== "instagram") {
    return { ok: false, error: "Invalid channel." };
  }

  const supabase = await createClient();
  const { error } = await supabase.from("channel_accounts").upsert(
    {
      tenant_id: tenantId,
      channel,
      status: "disconnected",
      external_page_id: null,
      external_account_id: null,
      metadata: {},
    },
    { onConflict: "tenant_id,channel" },
  );

  if (error) return { ok: false, error: error.message };

  const auditResult = await markTenantModified(tenantId, admin.id);
  if (!auditResult.ok) return auditResult;

  revalidateTenant(tenantId);
  return { ok: true };
}

export async function updateTenantAgentToggleAction(formData: FormData): Promise<ActionResult> {
  const admin = await requirePlatformAdmin();

  const tenantId = readTenantId(formData);
  const field = String(formData.get("field") ?? "").trim();
  const enabled = formData.get("enabled") === "true";

  if (!tenantId) return { ok: false, error: "Missing account id." };

  const allowedFields = {
    conciergeEnabled: "concierge_enabled",
    intakeEnabled: "intake_enabled",
  } as const;

  if (!(field in allowedFields)) {
    return { ok: false, error: "Invalid connection field." };
  }

  const supabase = await createClient();
  const { error } = await supabase
    .from("tenant_agents")
    .update({ [allowedFields[field as keyof typeof allowedFields]]: enabled })
    .eq("tenant_id", tenantId);

  if (error) return { ok: false, error: error.message };

  const auditResult = await markTenantModified(tenantId, admin.id);
  if (!auditResult.ok) return auditResult;

  revalidateTenant(tenantId);
  return { ok: true };
}
