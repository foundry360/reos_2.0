"use server";

import { revalidatePath } from "next/cache";
import { headers } from "next/headers";
import { requirePlatformAdmin } from "@/lib/admin/auth";
import { getSupabaseAdmin } from "@/lib/supabase/admin";

export interface PlatformAdminRow {
  userId: string;
  email: string;
  displayName: string;
  createdAt: string;
}

export async function findUserIdByEmail(
  admin: NonNullable<ReturnType<typeof getSupabaseAdmin>>,
  email: string,
): Promise<string | null> {
  const user = await findAuthUserByEmail(admin, email);
  return user?.id ?? null;
}

export async function findAuthUserByEmail(
  admin: NonNullable<ReturnType<typeof getSupabaseAdmin>>,
  email: string,
): Promise<{
  id: string;
  email: string;
  lastSignInAt: string | null;
  emailConfirmedAt: string | null;
} | null> {
  const normalized = email.toLowerCase();
  let page = 1;
  const perPage = 200;

  while (page <= 10) {
    const { data, error } = await admin.auth.admin.listUsers({ page, perPage });
    if (error || !data.users.length) break;

    const match = data.users.find(
      (user) => user.email?.toLowerCase() === normalized,
    );
    if (match?.id) {
      return {
        id: match.id,
        email: match.email ?? normalized,
        lastSignInAt: match.last_sign_in_at ?? null,
        emailConfirmedAt: match.email_confirmed_at ?? null,
      };
    }

    if (data.users.length < perPage) break;
    page += 1;
  }

  return null;
}

export async function listPlatformAdmins(): Promise<PlatformAdminRow[]> {
  await requirePlatformAdmin();

  const admin = getSupabaseAdmin();
  if (!admin) return [];

  const { data: rows, error } = await admin
    .from("platform_admins")
    .select("user_id, created_at")
    .order("created_at", { ascending: true });

  if (error || !rows?.length) {
    if (error) console.error("platform_admins list failed:", error.message);
    return [];
  }

  const results: PlatformAdminRow[] = [];

  for (const row of rows) {
    const { data: userData } = await admin.auth.admin.getUserById(row.user_id);
    const { data: profile } = await admin
      .from("profiles")
      .select("display_name")
      .eq("id", row.user_id)
      .maybeSingle();
    const email = userData.user?.email ?? "Unknown";
    const displayName = profile?.display_name?.trim() || email;
    results.push({
      userId: row.user_id,
      email,
      displayName,
      createdAt: row.created_at,
    });
  }

  return results;
}

export interface PlatformAdminOption {
  userId: string;
  label: string;
}

export async function listPlatformAdminOptions(): Promise<PlatformAdminOption[]> {
  const admins = await listPlatformAdmins();
  return admins.map((admin) => ({
    userId: admin.userId,
    label: admin.displayName,
  }));
}

export async function getPlatformAdminLabel(userId: string | null): Promise<string | null> {
  if (!userId) return null;

  const admins = await listPlatformAdmins();
  const match = admins.find((admin) => admin.userId === userId);
  if (match) return match.displayName;

  return getUserDisplayLabel(userId);
}

export async function getUserDisplayLabel(userId: string | null): Promise<string | null> {
  if (!userId) return null;

  const admin = getSupabaseAdmin();
  if (!admin) return null;

  const { data: profile } = await admin
    .from("profiles")
    .select("display_name")
    .eq("id", userId)
    .maybeSingle();

  if (profile?.display_name?.trim()) {
    return profile.display_name.trim();
  }

  const { data: userData } = await admin.auth.admin.getUserById(userId);
  return userData.user?.email ?? null;
}

export async function invitePlatformAdminAction(
  formData: FormData,
): Promise<{ ok: boolean; error?: string }> {
  await requirePlatformAdmin();

  const email = String(formData.get("email") ?? "").trim().toLowerCase();
  if (!email) {
    return { ok: false, error: "Email is required." };
  }

  const admin = getSupabaseAdmin();
  if (!admin) {
    return { ok: false, error: "Server configuration error (Supabase admin)." };
  }

  let userId = await findUserIdByEmail(admin, email);

  if (!userId) {
    const headerStore = await headers();
    const origin = headerStore.get("origin") ?? "http://localhost:3000";

    const { data: inviteData, error: inviteError } =
      await admin.auth.admin.inviteUserByEmail(email, {
        redirectTo: `${origin}/auth/callback?next=/admin`,
      });

    if (inviteError) {
      return { ok: false, error: inviteError.message };
    }

    userId = inviteData.user?.id ?? null;
  }

  if (!userId) {
    return { ok: false, error: "Could not resolve user for that email." };
  }

  const { error: insertError } = await admin.from("platform_admins").insert({
    user_id: userId,
  });

  if (insertError) {
    if (insertError.code === "23505") {
      return { ok: false, error: "That user is already a platform admin." };
    }
    return { ok: false, error: insertError.message };
  }

  revalidatePath("/admin/settings");
  return { ok: true };
}

export async function removePlatformAdminsAction(
  userIds: string[],
): Promise<{ ok: boolean; error?: string }> {
  const current = await requirePlatformAdmin();

  const unique = [...new Set(userIds.map((id) => id.trim()).filter(Boolean))];
  if (unique.length === 0) {
    return { ok: false, error: "No admins selected." };
  }

  if (unique.includes(current.id)) {
    return { ok: false, error: "You cannot remove your own platform admin access." };
  }

  const admin = getSupabaseAdmin();
  if (!admin) {
    return { ok: false, error: "Server configuration error (Supabase admin)." };
  }

  const { count, error: countError } = await admin
    .from("platform_admins")
    .select("*", { count: "exact", head: true });

  if (countError) {
    return { ok: false, error: countError.message };
  }

  const remaining = (count ?? 0) - unique.length;
  if (remaining < 1) {
    return { ok: false, error: "At least one platform admin must remain." };
  }

  for (const userId of unique) {
    const { error } = await admin.from("platform_admins").delete().eq("user_id", userId);
    if (error) return { ok: false, error: error.message };
  }

  revalidatePath("/admin/settings");
  return { ok: true };
}
