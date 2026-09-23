export interface PlaceSuggestion {
  id: string;
  label: string;
  secondary?: string | null;
  lat?: number | null;
  lng?: number | null;
  provider: "google";
}

export function formatPlaceDisplay(suggestion: PlaceSuggestion): string {
  if (suggestion.secondary) {
    return `${suggestion.label}, ${suggestion.secondary}`;
  }
  return suggestion.label;
}

