function sanitizeNextPath(raw: string | null | undefined): string {
  const value = raw?.trim() || "/overview";
  if (!value.startsWith("/") || value.startsWith("//")) return "/overview";
  if (value === "/") return "/overview";
  return value;
}

function isDefaultAppHome(path: string): boolean {
  return path === "/overview" || path === "/";
}

function isPasswordSetupPath(path: string): boolean {
  return path === "/set-password" || path.startsWith("/set-password?");
}

type PlatformAdminLookup = {
  from: (table: string) => {
    select: (columns: string) => {
      eq: (
        column: string,
        value: string,
      ) => {
        maybeSingle: () => Promise<{ data: { user_id: string } | null }>;
      };
    };
  };
};

/**
 * After sign-in: platform admins land in /admin unless they requested a
 * specific non-home path (e.g. deep link). Non-admins never land in /admin.
 * Password setup links always win over admin/home redirects.
 */
export async function resolvePostLoginPath(
  // Kept shallow on purpose: checking a full SupabaseClient against a union exceeds TS's instantiation depth.
  supabase: { from: (table: string) => unknown },
  userId: string,
  requestedNext?: string | null,
): Promise<string> {
  const next = sanitizeNextPath(requestedNext);

  if (isPasswordSetupPath(next)) {
    return "/set-password";
  }

  const { data: admin } = await (supabase as PlatformAdminLookup)
    .from("platform_admins")
    .select("user_id")
    .eq("user_id", userId)
    .maybeSingle();

  if (admin) {
    if (isDefaultAppHome(next)) return "/admin";
    return next;
  }

  if (next === "/admin" || next.startsWith("/admin/")) {
    return "/overview";
  }

  return next;
}
