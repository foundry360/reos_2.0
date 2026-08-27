import { requirePlatformAdmin } from "@/lib/admin/auth";
import { createClient } from "@/lib/supabase/server";

export interface TenantOption {
  id: string;
  name: string;
}

export async function listTenantOptions(): Promise<TenantOption[]> {
  await requirePlatformAdmin();
  const supabase = await createClient();

  const { data, error } = await supabase
    .from("tenants")
    .select("id, name")
    .order("name", { ascending: true });

  if (error) {
    console.error("tenant options query failed:", error.message);
    return [];
  }

  return data ?? [];
}
