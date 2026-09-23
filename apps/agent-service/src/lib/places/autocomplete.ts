import { getEnv } from "@/lib/env";
import type { PlaceSuggestion } from "./types";

const MAX_RESULTS = 8;

/** Approximate market centers for tenant timezone bias (US-focused). */
const TIMEZONE_CENTERS: Record<string, { lat: number; lng: number }> = {
  "America/New_York": { lat: 40.7128, lng: -74.006 },
  "America/Chicago": { lat: 41.8781, lng: -87.6298 },
  "America/Denver": { lat: 39.7392, lng: -104.9903 },
  "America/Los_Angeles": { lat: 34.0522, lng: -118.2437 },
  "America/Phoenix": { lat: 33.4484, lng: -112.074 },
};

const DEFAULT_CENTER = TIMEZONE_CENTERS["America/New_York"];
/** Google Places max locationBias radius is 50,000 meters. */
const BIAS_RADIUS_METERS = 50_000;

export interface PlaceSearchOptions {
  /** IANA timezone used to bias results toward the workspace market. */
  timeZone?: string | null;
  /** Optional ISO country codes (lowercase), e.g. ["us"]. */
  regionCodes?: string[];
}

function cleanPart(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed || null;
}

function resolveApiKey(): string | null {
  const env = getEnv();
  return env.GOOGLE_PLACES_API_KEY?.trim() || env.GOOGLE_MAPS_API_KEY?.trim() || null;
}

function centerForTimeZone(timeZone?: string | null): { lat: number; lng: number } {
  if (!timeZone) return DEFAULT_CENTER;
  return TIMEZONE_CENTERS[timeZone] ?? DEFAULT_CENTER;
}

async function searchGooglePlaces(
  query: string,
  apiKey: string,
  options: PlaceSearchOptions = {},
): Promise<PlaceSuggestion[]> {
  const center = centerForTimeZone(options.timeZone);
  const regionCodes =
    options.regionCodes && options.regionCodes.length > 0
      ? options.regionCodes
      : ["us"];

  const response = await fetch("https://places.googleapis.com/v1/places:autocomplete", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Goog-Api-Key": apiKey,
      "X-Goog-FieldMask":
        "suggestions.placePrediction.placeId,suggestions.placePrediction.text,suggestions.placePrediction.structuredFormat",
    },
    body: JSON.stringify({
      input: query,
      languageCode: "en",
      includedRegionCodes: regionCodes,
      locationBias: {
        circle: {
          center: {
            latitude: center.lat,
            longitude: center.lng,
          },
          radius: BIAS_RADIUS_METERS,
        },
      },
    }),
  });

  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new Error(`Google Places failed (${response.status}): ${detail.slice(0, 240)}`);
  }

  const data = (await response.json()) as {
    suggestions?: Array<{
      placePrediction?: {
        placeId?: string;
        text?: { text?: string };
        structuredFormat?: {
          mainText?: { text?: string };
          secondaryText?: { text?: string };
        };
      };
    }>;
  };

  const suggestions: PlaceSuggestion[] = [];
  for (const [index, suggestion] of (data.suggestions ?? []).entries()) {
    if (suggestions.length >= MAX_RESULTS) break;
    const prediction = suggestion.placePrediction;
    if (!prediction) continue;

    const fullText = cleanPart(prediction.text?.text);
    const main =
      cleanPart(prediction.structuredFormat?.mainText?.text) || fullText || "Selected location";
    const secondary =
      cleanPart(prediction.structuredFormat?.secondaryText?.text) ||
      (fullText && fullText !== main ? fullText : null);

    suggestions.push({
      id: `google:${prediction.placeId ?? index}`,
      label: main,
      secondary,
      lat: null,
      lng: null,
      provider: "google",
    });
  }
  return suggestions;
}

export function isGooglePlacesConfigured(): boolean {
  return Boolean(resolveApiKey());
}

/**
 * Place typeahead via Google Places Autocomplete (New), biased to the
 * workspace timezone market and limited to configured regions (default US).
 */
export async function searchPlaces(
  query: string,
  options: PlaceSearchOptions = {},
): Promise<PlaceSuggestion[]> {
  const trimmed = query.trim();
  if (trimmed.length < 2) return [];

  const apiKey = resolveApiKey();
  if (!apiKey) {
    throw new Error(
      "Google Maps is not configured. Set GOOGLE_PLACES_API_KEY (Places API New) in the environment.",
    );
  }

  return searchGooglePlaces(trimmed, apiKey, options);
}
