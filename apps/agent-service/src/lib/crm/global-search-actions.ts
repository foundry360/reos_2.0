"use server";

import { searchTenantGlobal, type GlobalSearchResult } from "@/lib/crm/global-search";

export async function searchTenantGlobalAction(
  query: string,
): Promise<{ ok: true; results: GlobalSearchResult[] } | { ok: false; error: string }> {
  try {
    const results = await searchTenantGlobal(query);
    return { ok: true, results };
  } catch (error) {
    console.error("global search failed:", error);
    return { ok: false, error: "Search failed. Try again." };
  }
}
