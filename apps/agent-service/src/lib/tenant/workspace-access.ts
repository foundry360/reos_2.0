import { cache } from "react";
import { isPlatformAdmin } from "@/lib/admin/auth";
import { createClient } from "@/lib/supabase/server";
import { resolveCurrentTenant } from "@/lib/tenant/current-tenant";

export type WorkspaceRole = "owner" | "agent" | "viewer";

export interface WorkspaceAccess {
  userId: string;
  tenantId: string;
  role: WorkspaceRole | null;
  platformAdmin: boolean;
  /** Owners and platform admins manage workspace-wide connections. */
  canManageChannels: boolean;
}

function parseRole(value: unknown): WorkspaceRole | null {
  return value === "owner" || value === "agent" || value === "viewer" ? value : null;
}

async function membershipRole(userId: string, tenantId: string): Promise<WorkspaceRole | null> {
  const supabase = await createClient();
  const { data } = await supabase
    .from("memberships")
    .select("role")
    .eq("user_id", userId)
    .eq("tenant_id", tenantId)
    .maybeSingle();
  return parseRole(data?.role);
}

/** Current user's access to the active workspace, or null when signed out / no workspace. */
export const getWorkspaceAccess = cache(async (): Promise<WorkspaceAccess | null> => {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return null;

  const { tenantId } = await resolveCurrentTenant();
  if (!tenantId) return null;

  const [role, platformAdmin] = await Promise.all([
    membershipRole(user.id, tenantId),
    isPlatformAdmin(user.id),
  ]);

  return {
    userId: user.id,
    tenantId,
    role,
    platformAdmin,
    canManageChannels: platformAdmin || role === "owner",
  };
});

/**
 * Signed-in user allowed to manage channels for `tenantId`, or null.
 * Platform admins manage any workspace; owners manage their own.
 */
export async function authorizeChannelManager(
  tenantId: string,
): Promise<{ userId: string; platformAdmin: boolean } | null> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user || !tenantId) return null;

  const platformAdmin = await isPlatformAdmin(user.id);
  if (platformAdmin) return { userId: user.id, platformAdmin };
  if ((await membershipRole(user.id, tenantId)) !== "owner") return null;
  return { userId: user.id, platformAdmin: false };
}
