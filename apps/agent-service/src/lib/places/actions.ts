"use server";

import { createClient } from "@/lib/supabase/server";
import { resolveCurrentTenant } from "@/lib/tenant/current-tenant";
import {
  isGooglePlacesConfigured,
  searchPlaces,
} from "@/lib/places/autocomplete";
import type { PlaceSuggestion } from "@/lib/places/types";

async function loadTenantTimeZone(tenantId: string): Promise<string | null> {
  const supabase = await createClient();
  const { data } = await supabase
    .from("tenants")
    .select("timezone")
    .eq("id", tenantId)
    .maybeSingle();
  return data?.timezone?.trim() || null;
}

export async function searchPlacesAction(
  query: string,
): Promise<{ ok: true; results: PlaceSuggestion[] } | { ok: false; error: string }> {
  const { tenantId } = await resolveCurrentTenant();
  if (!tenantId) {
    return { ok: false, error: "Sign in to search locations." };
  }

  if (!isGooglePlacesConfigured()) {
    return {
      ok: false,
      error:
        "Google Maps is not configured. Add GOOGLE_PLACES_API_KEY to enable location search.",
    };
  }

  try {
    const timeZone = await loadTenantTimeZone(tenantId);
    const results = await searchPlaces(query, { timeZone, regionCodes: ["us"] });
    return { ok: true, results };
  } catch (error) {
    console.error("places autocomplete failed:", error);
    return {
      ok: false,
      error:
        error instanceof Error && error.message.includes("Google Places failed")
          ? "Google Maps could not search that location. Check the API key and Places API (New)."
          : "Could not search locations. Try again.",
    };
  }
}
