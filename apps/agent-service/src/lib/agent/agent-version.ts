import { getSupabaseAdmin } from "@/lib/supabase/admin";

const CACHE_MS = 60_000;
const cache = new Map<string, { version: number; at: number }>();

/** tenants.agent_version: 1 = routed playbooks, 2 = single lead agent. Missing column or row -> 1. */
export async function tenantAgentVersion(tenantId: string): Promise<number> {
  if (!tenantId || tenantId === "default-tenant") return 1;
  const hit = cache.get(tenantId);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.version;

  const db = getSupabaseAdmin();
  if (!db) return 1;
  const { data, error } = await db.from("tenants").select("agent_version").eq("id", tenantId).maybeSingle();
  if (error && !/agent_version|schema cache|column/i.test(error.message)) {
    console.warn("agent_version lookup failed:", error.message);
  }
  const version = !error && data?.agent_version === 2 ? 2 : 1;
  cache.set(tenantId, { version, at: Date.now() });
  return version;
}
