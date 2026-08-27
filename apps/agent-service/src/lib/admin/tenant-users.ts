import { createClient } from "@/lib/supabase/server";
import { requirePlatformAdmin } from "@/lib/admin/auth";
import { getSupabaseAdmin } from "@/lib/supabase/admin";

export type TenantUserRole = "owner" | "agent" | "viewer";

export interface TenantUser {
  membershipId: string;
  userId: string;
  name: string;
  email: string;
  phone: string | null;
  userType: TenantUserRole;
  userTypeLabel: string;
}

const USER_TYPE_LABELS: Record<TenantUserRole, string> = {
  owner: "Owner",
  agent: "Agent",
  viewer: "Viewer",
};

export function formatUserTypeLabel(role: TenantUserRole): string {
  return USER_TYPE_LABELS[role];
}

export async function getTenantUsers(tenantId: string): Promise<TenantUser[]> {
  await requirePlatformAdmin();
  const supabase = await createClient();

  const { data: memberships, error } = await supabase
    .from("memberships")
    .select("id, user_id, role")
    .eq("tenant_id", tenantId)
    .order("created_at", { ascending: true });

  if (error || !memberships?.length) {
    if (error) console.error("memberships list failed:", error.message);
    return [];
  }

  const admin = getSupabaseAdmin();
  const users: TenantUser[] = [];

  for (const membership of memberships) {
    const role = membership.role as TenantUserRole;

    const [{ data: profile }, authUser] = await Promise.all([
      supabase
        .from("profiles")
        .select("display_name, phone")
        .eq("id", membership.user_id)
        .maybeSingle(),
      admin
        ? admin.auth.admin.getUserById(membership.user_id)
        : Promise.resolve({ data: { user: null }, error: null }),
    ]);

    const email = authUser.data.user?.email ?? "Unknown";
    const name = profile?.display_name?.trim() || email.split("@")[0] || "Unknown";

    users.push({
      membershipId: membership.id,
      userId: membership.user_id,
      name,
      email,
      phone: profile?.phone ?? authUser.data.user?.phone ?? null,
      userType: role,
      userTypeLabel: formatUserTypeLabel(role),
    });
  }

  return users;
}
