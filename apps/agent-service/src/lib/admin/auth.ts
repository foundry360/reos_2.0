import { createClient } from "@/lib/supabase/server";
import { redirect } from "next/navigation";

export interface AdminUser {
  id: string;
  email: string;
}

export async function requirePlatformAdmin(): Promise<AdminUser> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user?.email) {
    redirect("/login?next=/admin");
  }

  const { data: admin, error: adminError } = await supabase
    .from("platform_admins")
    .select("user_id")
    .eq("user_id", user.id)
    .maybeSingle();

  if (adminError) {
    console.error("platform_admins lookup failed:", adminError.message);
    throw new Error(
      "Could not verify admin access. Run migration 002_platform_admins_policy.sql in Supabase.",
    );
  }

  if (!admin) {
    redirect("/?error=not_platform_admin");
  }

  return { id: user.id, email: user.email };
}

export async function isPlatformAdmin(userId: string): Promise<boolean> {
  const supabase = await createClient();
  const { data } = await supabase
    .from("platform_admins")
    .select("user_id")
    .eq("user_id", userId)
    .maybeSingle();
  return Boolean(data);
}
