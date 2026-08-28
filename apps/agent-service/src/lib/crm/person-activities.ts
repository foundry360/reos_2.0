export const ACTIVITY_TYPE_OPTIONS = [
  { value: "note", label: "Note" },
  { value: "call", label: "Call" },
  { value: "email", label: "Email" },
  { value: "meeting", label: "Meeting" },
  { value: "other", label: "Other" },
] as const;

export type ActivityType = (typeof ACTIVITY_TYPE_OPTIONS)[number]["value"];

/** Includes system-generated types not shown in the log-activity picker. */
export type StoredActivityType = ActivityType | "opportunity" | "contact";

export function isActivityType(value: string): value is ActivityType {
  return ACTIVITY_TYPE_OPTIONS.some((option) => option.value === value);
}

export function isStoredActivityType(value: string): value is StoredActivityType {
  return isActivityType(value) || value === "opportunity" || value === "contact";
}

export function formatActivityTypeLabel(type: string): string {
  if (type === "opportunity") return "Opportunity";
  if (type === "contact") return "Contact";
  const match = ACTIVITY_TYPE_OPTIONS.find((option) => option.value === type);
  if (match) return match.label;
  return type.charAt(0).toUpperCase() + type.slice(1);
}

export interface PersonActivityItem {
  id: string;
  source: "activity" | "message" | "task";
  type: string;
  typeLabel: string;
  title: string;
  body: string | null;
  occurredAt: string;
}

export interface PersonTaskSummary {
  id: string;
  title: string;
  status: "open" | "done";
  dueAt: string | null;
  notes: string | null;
  updatedAt: string;
  createdAt: string;
}
