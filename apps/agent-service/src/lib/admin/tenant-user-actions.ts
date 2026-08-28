"use server";

import { revalidatePath } from "next/cache";
import { headers } from "next/headers";
import { requirePlatformAdmin } from "@/lib/admin/auth";
import { findAuthUserByEmail } from "@/lib/admin/platform-admin-actions";
import { createClient } from "@/lib/supabase/server";
import { getSupabaseAdmin } from "@/lib/supabase/admin";
import type { TenantUserRole } from "@/lib/admin/tenant-users";
import { parsePhoneForStorage } from "@/lib/phone-display";
import { sendPasswordSetupEmail } from "@/lib/auth/send-password-setup-email";
import { buildAcceptInviteUrl } from "@/lib/auth/invite-token";

export interface ActionResult {
  ok: boolean;
  error?: string;
  invited?: boolean;
  message?: string;
  /** Present when email could not be sent (e.g. Supabase rate limit). */
  inviteUrl?: string;
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

function resolveAppOrigin(headerStore: Headers): string {
  const origin = headerStore.get("origin");
  if (origin) return origin;
  const host = headerStore.get("x-forwarded-host") ?? headerStore.get("host");
  const proto = headerStore.get("x-forwarded-proto") ?? "http";
  if (host) return `${proto}://${host}`;
  return process.env.NEXT_PUBLIC_SITE_URL ?? "http://localhost:3000";
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

  const headerStore = await headers();
  const origin = resolveAppOrigin(headerStore);

  const existingUser = await findAuthUserByEmail(admin, email);
  let userId = existingUser?.id ?? null;

  if (userId) {
    const { data: existingMembership } = await supabase
      .from("memberships")
      .select("id")
      .eq("tenant_id", tenantId)
      .eq("user_id", userId)
      .maybeSingle();

    if (existingMembership) {
      const resent = await sendPasswordSetupEmail(admin, email, origin, userId);
      if (!resent.ok) return { ok: false, error: resent.error };
      if (!resent.emailed) {
        return {
          ok: true,
          invited: true,
          inviteUrl: buildAcceptInviteUrl(origin, email),
          message:
            "Supabase email rate limit hit. Open this invite link in a private window (email will work again after the limit resets, or add custom SMTP).",
        };
      }
      return {
        ok: true,
        invited: true,
        message:
          "User is already on this account. A fresh password setup email was sent.",
      };
    }
  }

  const invited = await sendPasswordSetupEmail(admin, email, origin, userId);
  if (!invited.ok) return { ok: false, error: invited.error };
  userId = invited.userId;

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

  if (!invited.emailed) {
    return {
      ok: true,
      invited: true,
      inviteUrl: buildAcceptInviteUrl(origin, email),
      message:
        "User added, but Supabase email rate limit hit. Open this invite link in a private window for now.",
    };
  }

  return {
    ok: true,
    invited: true,
    message:
      "Invite email sent. They should open the link, set a password, then enter the workspace.",
  };
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
  revalidatePath("/admin/users");
  return { ok: true };
}

export async function deleteTenantUsersAction(
  items: { tenantId: string; membershipId: string }[],
): Promise<ActionResult> {
  await requirePlatformAdmin();

  const unique = items.filter(
    (item, index, all) =>
      item.tenantId.trim() &&
      item.membershipId.trim() &&
      all.findIndex(
        (other) =>
          other.tenantId === item.tenantId && other.membershipId === item.membershipId,
      ) === index,
  );

  if (unique.length === 0) {
    return { ok: false, error: "No users selected." };
  }

  const supabase = await createClient();
  for (const item of unique) {
    const { error } = await supabase
      .from("memberships")
      .delete()
      .eq("id", item.membershipId.trim())
      .eq("tenant_id", item.tenantId.trim());

    if (error) return { ok: false, error: error.message };
  }

  for (const tenantId of new Set(unique.map((item) => item.tenantId.trim()))) {
    revalidateTenant(tenantId);
  }

  revalidatePath("/admin/users");
  return { ok: true };
}
