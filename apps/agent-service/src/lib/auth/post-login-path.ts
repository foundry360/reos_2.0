import type { SupabaseClient } from "@supabase/supabase-js";

function sanitizeNextPath(raw: string | null | undefined): string {
  const value = raw?.trim() || "/overview";
  if (!value.startsWith("/") || value.startsWith("//")) return "/overview";
  if (value === "/") return "/overview";
  return value;
}

function isDefaultAppHome(path: string): boolean {
  return path === "/overview" || path === "/";
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
 */
export async function resolvePostLoginPath(
  supabase: SupabaseClient | PlatformAdminLookup,
  userId: string,
  requestedNext?: string | null,
): Promise<string> {
  const next = sanitizeNextPath(requestedNext);

  const { data: admin } = await supabase
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
