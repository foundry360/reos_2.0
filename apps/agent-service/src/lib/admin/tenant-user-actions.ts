"use server";

import { revalidatePath } from "next/cache";
import { headers } from "next/headers";
import { requirePlatformAdmin } from "@/lib/admin/auth";
import { findUserIdByEmail } from "@/lib/admin/platform-admin-actions";
import { createClient } from "@/lib/supabase/server";
import { getSupabaseAdmin } from "@/lib/supabase/admin";
import type { TenantUserRole } from "@/lib/admin/tenant-users";
import { parsePhoneForStorage } from "@/lib/phone-display";

export interface ActionResult {
  ok: boolean;
  error?: string;
  invited?: boolean;
}

function revalidateTenant(tenantId: string) {
  revalidatePath("/admin");
  revalidatePath("/admin/users");
  revalidatePath(`/admin/accounts/${tenantId}`);
}

function readRole(value: string): TenantUserRole | null {
  if (value === "owner" || value === "agent" || value === "viewer") return value;
  return null;
}

export async function updateTenantUserAction(formData: FormData): Promise<ActionResult> {
  await requirePlatformAdmin();

  const tenantId = String(formData.get("tenantId") ?? "").trim();
  const membershipId = String(formData.get("membershipId") ?? "").trim();
  const userId = String(formData.get("userId") ?? "").trim();
  const name = String(formData.get("name") ?? "").trim();
  const phoneRaw = String(formData.get("phone") ?? "").trim();
  const role = readRole(String(formData.get("userType") ?? "").trim());

  if (!tenantId || !membershipId || !userId) {
    return { ok: false, error: "Missing user reference." };
  }
  if (!name) return { ok: false, error: "Name is required." };
  if (!role) return { ok: false, error: "Invalid user type." };

  const phoneResult = parsePhoneForStorage(phoneRaw);
  if (!phoneResult.ok) return { ok: false, error: phoneResult.error };
  const phone = phoneResult.phone;

  const supabase = await createClient();
  const { error: membershipError } = await supabase
    .from("memberships")
    .update({ role })
    .eq("id", membershipId)
    .eq("tenant_id", tenantId)
    .eq("user_id", userId);

  if (membershipError) return { ok: false, error: membershipError.message };

  const admin = getSupabaseAdmin();
  if (!admin) return { ok: false, error: "Server configuration error (Supabase admin)." };

  const { error: profileError } = await admin.from("profiles").upsert({
    id: userId,
    display_name: name,
    phone,
  });

  if (profileError) return { ok: false, error: profileError.message };

  revalidateTenant(tenantId);
  return { ok: true };
}

export async function createTenantUserAction(formData: FormData): Promise<ActionResult> {
  const adminUser = await requirePlatformAdmin();

  const tenantId = String(formData.get("tenantId") ?? "").trim();
  const email = String(formData.get("email") ?? "").trim().toLowerCase();
  const nameInput = String(formData.get("name") ?? "").trim();
  const phoneRaw = String(formData.get("phone") ?? "").trim();
  const role = readRole(String(formData.get("userType") ?? "").trim());

  if (!tenantId) return { ok: false, error: "Missing account id." };
  if (!email) return { ok: false, error: "Email is required." };
  if (!role) return { ok: false, error: "Invalid user type." };

  const phoneResult = parsePhoneForStorage(phoneRaw);
  if (!phoneResult.ok) return { ok: false, error: phoneResult.error };
  const phone = phoneResult.phone;

  const name = nameInput || email.split("@")[0] || "User";

  const supabase = await createClient();
  const admin = getSupabaseAdmin();
  if (!admin) return { ok: false, error: "Server configuration error (Supabase admin)." };

  let userId = await findUserIdByEmail(admin, email);
  let invited = false;

  if (!userId) {
    const headerStore = await headers();
    const origin = headerStore.get("origin") ?? "http://localhost:3000";

    const { data: inviteData, error: inviteError } = await admin.auth.admin.inviteUserByEmail(
      email,
      {
        redirectTo: `${origin}/auth/callback?next=/`,
      },
    );

    if (inviteError) return { ok: false, error: inviteError.message };

    userId = inviteData.user?.id ?? null;
    invited = true;
  }

  if (!userId) return { ok: false, error: "Could not resolve user for that email." };

  const { data: existingMembership } = await supabase
    .from("memberships")
    .select("id")
    .eq("tenant_id", tenantId)
    .eq("user_id", userId)
    .maybeSingle();

  if (existingMembership) {
    return { ok: false, error: "That user is already on this account." };
  }

  const { error: membershipError } = await supabase.from("memberships").insert({
    tenant_id: tenantId,
    user_id: userId,
    role,
  });

  if (membershipError) return { ok: false, error: membershipError.message };

  const { error: profileError } = await admin.from("profiles").upsert({
    id: userId,
    display_name: name,
    phone,
  });

  if (profileError) return { ok: false, error: profileError.message };

  const { error: auditError } = await supabase
    .from("tenants")
    .update({ last_modified_by_id: adminUser.id })
    .eq("id", tenantId);

  if (auditError) return { ok: false, error: auditError.message };

  revalidateTenant(tenantId);
  return { ok: true, invited };
}

export async function deleteTenantUserAction(formData: FormData): Promise<ActionResult> {
  await requirePlatformAdmin();

  const tenantId = String(formData.get("tenantId") ?? "").trim();
  const membershipId = String(formData.get("membershipId") ?? "").trim();

  if (!tenantId || !membershipId) {
    return { ok: false, error: "Missing user reference." };
  }

  const supabase = await createClient();
  const { error } = await supabase
    .from("memberships")
    .delete()
    .eq("id", membershipId)
    .eq("tenant_id", tenantId);

  if (error) return { ok: false, error: error.message };

  revalidateTenant(tenantId);
  return { ok: true };
}
