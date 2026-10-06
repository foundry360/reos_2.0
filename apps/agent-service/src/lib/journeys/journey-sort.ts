import type { JourneySummary } from "./journey-types";

export const JOURNEY_SORT_GROUPS = [
  [
    { id: "name_asc", label: "Name: A-Z" },
    { id: "name_desc", label: "Name: Z-A" },
  ],
  [
    { id: "updated", label: "Last edited" },
    { id: "created_desc", label: "Created: newest" },
    { id: "created_asc", label: "Created: oldest" },
  ],
  [{ id: "runs", label: "Most runs" }],
] as const;

export type JourneySort = (typeof JOURNEY_SORT_GROUPS)[number][number]["id"];

export const DEFAULT_JOURNEY_SORT: JourneySort = "updated";

const SORT_IDS = new Set<string>(JOURNEY_SORT_GROUPS.flat().map((option) => option.id));

export function parseJourneySort(value: unknown): JourneySort {
  return typeof value === "string" && SORT_IDS.has(value) ? (value as JourneySort) : DEFAULT_JOURNEY_SORT;
}

export function journeySortLabel(sort: JourneySort): string {
  return JOURNEY_SORT_GROUPS.flat().find((option) => option.id === sort)?.label ?? "";
}

const byName = (a: JourneySummary, b: JourneySummary) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" });
const byTime = (key: "createdAt" | "updatedAt") => (a: JourneySummary, b: JourneySummary) =>
  Date.parse(a[key]) - Date.parse(b[key]);

export function sortJourneys(journeys: JourneySummary[], sort: JourneySort): JourneySummary[] {
  const sorted = [...journeys];
  switch (sort) {
    case "name_asc":
      return sorted.sort(byName);
    case "name_desc":
      return sorted.sort((a, b) => byName(b, a));
    case "created_desc":
      return sorted.sort((a, b) => byTime("createdAt")(b, a));
    case "created_asc":
      return sorted.sort(byTime("createdAt"));
    case "runs":
      return sorted.sort((a, b) => b.runCount - a.runCount || byName(a, b));
    case "updated":
      return sorted.sort((a, b) => byTime("updatedAt")(b, a));
  }
}
