"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { cookies } from "next/headers";
import { isValidTenantStatus } from "@/lib/admin/account-status";
import { requirePlatformAdmin } from "@/lib/admin/auth";
import { slugify } from "@/lib/admin/slug";
import { createClient } from "@/lib/supabase/server";

export interface CreateTenantInput {
  name: string;
  slug?: string;
  principalFirstName: string;
  principalLastName: string;
  timezone: string;
}

export interface CreateTenantResult {
  ok: boolean;
  error?: string;
  tenantId?: string;
}

export async function createTenant(input: CreateTenantInput): Promise<CreateTenantResult> {
  const admin = await requirePlatformAdmin();

  const name = input.name.trim();
  const slug = (input.slug?.trim() || slugify(name)).toLowerCase();
  const principalFirstName = input.principalFirstName.trim();
  const principalLastName = input.principalLastName.trim();

  if (!name || !slug || !principalFirstName || !principalLastName) {
    return {
      ok: false,
      error: "Realtor name, account name, and principal name are required.",
    };
  }

  const supabase = await createClient();
  const { data: tenant, error: tenantError } = await supabase
    .from("tenants")
    .insert({
      name,
      slug,
      principal_first_name: principalFirstName,
      principal_last_name: principalLastName,
      timezone: input.timezone || "America/New_York",
      status: "company_info",
      account_type: "Tenant",
      account_owner_id: admin.id,
      created_by_id: admin.id,
      last_modified_by_id: admin.id,
    })
    .select("id")
    .single();

  if (tenantError || !tenant) {
    if (tenantError?.code === "23505") {
      return { ok: false, error: "That slug is already in use." };
    }
    return { ok: false, error: tenantError?.message ?? "Failed to create tenant." };
  }

  revalidatePath("/admin");
  return { ok: true, tenantId: tenant.id };
}

export async function createTenantFormAction(
  formData: FormData,
): Promise<CreateTenantResult> {
  return createTenant({
    name: String(formData.get("name") ?? ""),
    slug: String(formData.get("slug") ?? ""),
    principalFirstName: String(formData.get("principalFirstName") ?? ""),
    principalLastName: String(formData.get("principalLastName") ?? ""),
    timezone: String(formData.get("timezone") ?? "America/New_York"),
  });
}

export async function createTenantAndRedirect(formData: FormData): Promise<void> {
  const result = await createTenant({
    name: String(formData.get("name") ?? ""),
    slug: String(formData.get("slug") ?? ""),
    principalFirstName: String(formData.get("principalFirstName") ?? ""),
    principalLastName: String(formData.get("principalLastName") ?? ""),
    timezone: String(formData.get("timezone") ?? "America/New_York"),
  });

  if (!result.ok || !result.tenantId) {
    redirect(`/admin/accounts/new?error=${encodeURIComponent(result.error ?? "Unknown error")}`);
  }

  redirect(`/admin/accounts/${result.tenantId}?created=1`);
}

export async function updateTenantStatus(tenantId: string, status: string): Promise<void> {
  await requirePlatformAdmin();
  if (!isValidTenantStatus(status)) {
    throw new Error("Invalid status.");
  }
  const supabase = await createClient();
  await supabase.from("tenants").update({ status }).eq("id", tenantId);
  revalidatePath("/admin");
  revalidatePath(`/admin/accounts/${tenantId}`);
}

const IMPERSONATE_COOKIE = "reos_impersonate_tenant";

export async function startImpersonation(tenantId: string): Promise<void> {
  await requirePlatformAdmin();
  const cookieStore = await cookies();
  cookieStore.set(IMPERSONATE_COOKIE, tenantId, {
    httpOnly: true,
    sameSite: "lax",
    path: "/",
    maxAge: 60 * 60 * 8,
  });
  redirect("/");
}

export async function stopImpersonation(): Promise<void> {
  const cookieStore = await cookies();
  cookieStore.delete(IMPERSONATE_COOKIE);
  redirect("/admin");
}

export async function getImpersonatedTenantId(): Promise<string | null> {
  const cookieStore = await cookies();
  return cookieStore.get(IMPERSONATE_COOKIE)?.value ?? null;
}
