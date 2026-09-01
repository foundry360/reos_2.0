export const ACTIVITY_TYPE_OPTIONS = [
  { value: "note", label: "Note" },
  { value: "call", label: "Call" },
  { value: "email", label: "Email" },
  { value: "meeting", label: "Meeting" },
  { value: "other", label: "Other" },
] as const;

export type ActivityType = (typeof ACTIVITY_TYPE_OPTIONS)[number]["value"];

/** Includes system-generated types not shown in the log-activity picker. */
export type StoredActivityType =
  | ActivityType
  | "opportunity"
  | "contact"
  | "appointment";

export type ActivityRelatedEntityType =
  | "contact"
  | "lead"
  | "opportunity"
  | "task";

/** Feed categories for Recent activities (chat messages are excluded). */
export type ActivityCategory =
  | "lead_contact"
  | "opportunity"
  | "appointment"
  | "task"
  | "other";

export const ACTIVITY_CATEGORY_META: Record<
  ActivityCategory,
  { label: string; color: string }
> = {
  lead_contact: { label: "Lead & Client", color: "#3B82F6" },
  opportunity: { label: "Opportunity", color: "#22C55E" },
  appointment: { label: "Appointments", color: "#A855F7" },
  task: { label: "Tasks & Follow-ups", color: "#F97316" },
  other: { label: "Other", color: "#94A3B8" },
};

export function isActivityType(value: string): value is ActivityType {
  return ACTIVITY_TYPE_OPTIONS.some((option) => option.value === value);
}

export function isStoredActivityType(value: string): value is StoredActivityType {
  return (
    isActivityType(value) ||
    value === "opportunity" ||
    value === "contact" ||
    value === "appointment"
  );
}

export function classifyActivityCategory(item: {
  type: string;
  source: string;
  title: string;
}): ActivityCategory {
  if (item.source === "task" || item.type === "task") return "task";
  if (item.type === "appointment" || item.type === "meeting") return "appointment";
  if (item.type === "opportunity") return "opportunity";
  if (item.type === "contact") return "lead_contact";
  if (/^appointment\b/i.test(item.title)) return "appointment";
  if (/^(new opportunity|opportunity )\b/i.test(item.title)) return "opportunity";
  if (/^(new lead|lead |contact )\b/i.test(item.title)) return "lead_contact";
  if (/^(task |follow-up )\b/i.test(item.title)) return "task";
  return "other";
}

export function formatActivityTypeLabel(type: string): string {
  if (type === "opportunity") return "Opportunity";
  if (type === "contact") return "Lead & Client";
  if (type === "appointment") return "Appointments";
  if (type === "task") return "Tasks & Follow-ups";
  if (type === "meeting") return "Appointments";
  const match = ACTIVITY_TYPE_OPTIONS.find((option) => option.value === type);
  if (match) return match.label;
  return type.charAt(0).toUpperCase() + type.slice(1);
}

export function activityEntityHref(
  entityType: string | null | undefined,
  entityId: string | null | undefined,
): string | null {
  if (!entityType || !entityId) return null;
  switch (entityType) {
    case "opportunity":
      return `/opportunities/${entityId}`;
    case "contact":
      return `/contacts/${entityId}`;
    case "lead":
      return `/leads/${entityId}`;
    case "task":
      return "/tasks";
    default:
      return null;
  }
}

/** Whether an item belongs on Recent activities / Activities (no chat). */
export function isCrmActivityFeedItem(item: {
  source: string;
  type: string;
}): boolean {
  if (item.source === "message" || item.type === "message") return false;
  return true;
}

export interface PersonActivityItem {
  id: string;
  source: "activity" | "message" | "task";
  type: string;
  typeLabel: string;
  category: ActivityCategory;
  categoryLabel: string;
  title: string;
  body: string | null;
  occurredAt: string;
  href: string | null;
  /** When set, the card timestamp is shown as a due date. */
  timeKind?: "due";
}

export interface PersonTaskSummary {
  id: string;
  title: string;
  status: "open" | "done";
  dueAt: string | null;
  startAt: string | null;
  endAt: string | null;
  notes: string | null;
  updatedAt: string;
  createdAt: string;
}
