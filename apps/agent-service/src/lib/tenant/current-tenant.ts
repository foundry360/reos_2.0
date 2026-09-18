import { cache } from "react";
import { getImpersonatedTenantId } from "@/lib/admin/actions";
import { isPlatformAdmin } from "@/lib/admin/auth";
import { createClient } from "@/lib/supabase/server";

export interface CurrentTenantContext {
  tenantId: string | null;
  /** Why tenant could not be resolved, for empty-state copy. */
  reason: "unauthenticated" | "no_membership" | null;
}

export interface AssignedTenant {
  id: string;
  name: string;
}

/** Tenants this user is a member of, for the avatar workspace switcher. */
export async function listAssignedTenants(userId: string): Promise<AssignedTenant[]> {
  const supabase = await createClient();
  const { data: memberships, error } = await supabase
    .from("memberships")
    .select("tenant_id")
    .eq("user_id", userId);

  if (error || !memberships?.length) {
    if (error) console.error("assigned tenants lookup failed:", error.message);
    return [];
  }

  const ids = [
    ...new Set(
      memberships
        .map((row) => row.tenant_id)
        .filter((id): id is string => Boolean(id)),
    ),
  ];
  if (ids.length === 0) return [];

  const { data: tenants, error: tenantError } = await supabase
    .from("tenants")
    .select("id, name")
    .in("id", ids);

  if (tenantError || !tenants?.length) {
    if (tenantError) console.error("assigned tenant names failed:", tenantError.message);
    return [];
  }

  return tenants
    .flatMap((tenant) => {
      const name = tenant.name?.trim();
      if (!tenant.id || !name) return [];
      return [{ id: tenant.id, name }];
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Resolve the active workspace for the logged-in tenant user.
 * Uses membership first. Impersonation is only a fallback for platform ops
 * previewing a tenant they are not a member of.
 */
export const resolveCurrentTenant = cache(async (): Promise<CurrentTenantContext> => {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return { tenantId: null, reason: "unauthenticated" };
  }

  const { data: memberships } = await supabase
    .from("memberships")
    .select("tenant_id")
    .eq("user_id", user.id);

  const membershipIds = (memberships ?? [])
    .map((row) => row.tenant_id)
    .filter((id): id is string => Boolean(id));

  const impersonated = await getImpersonatedTenantId();
  if (impersonated && membershipIds.includes(impersonated)) {
    return { tenantId: impersonated, reason: null };
  }

  if (membershipIds[0]) {
    return { tenantId: membershipIds[0], reason: null };
  }

  const platformAdmin = await isPlatformAdmin(user.id);
  if (platformAdmin && impersonated) {
    return { tenantId: impersonated, reason: null };
  }

  return { tenantId: null, reason: "no_membership" };
});

export function workspaceUnavailableMessage(reason: string | null): string {
  if (reason === "unauthenticated") {
    return "Sign in to access your workspace.";
  }
  return "Your account is not linked to a workspace yet. Ask your brokerage owner for an invite.";
}
