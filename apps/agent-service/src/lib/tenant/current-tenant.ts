import { cache } from "react";
import { getImpersonatedTenantId } from "@/lib/admin/actions";
import { isPlatformAdmin } from "@/lib/admin/auth";
import { createClient } from "@/lib/supabase/server";

export interface CurrentTenantContext {
  tenantId: string | null;
  /** Why tenant could not be resolved, for empty-state copy. */
  reason: "unauthenticated" | "no_membership" | null;
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
    .eq("user_id", user.id)
    .limit(1);

  const membershipTenantId = memberships?.[0]?.tenant_id ?? null;
  if (membershipTenantId) {
    return { tenantId: membershipTenantId, reason: null };
  }

  const platformAdmin = await isPlatformAdmin(user.id);
  if (platformAdmin) {
    const impersonated = await getImpersonatedTenantId();
    if (impersonated) {
      return { tenantId: impersonated, reason: null };
    }
  }

  return { tenantId: null, reason: "no_membership" };
});

export function workspaceUnavailableMessage(reason: string | null): string {
  if (reason === "unauthenticated") {
    return "Sign in to access your workspace.";
  }
  return "Your account is not linked to a workspace yet. Ask your brokerage owner for an invite.";
}
