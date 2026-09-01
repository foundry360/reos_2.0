export type CalendarView = "day" | "week" | "month" | "agenda";

export type CalendarEventKind = "appointment" | "task" | "other" | "google" | "social";

export const CALENDAR_EVENT_KINDS: CalendarEventKind[] = [
  "appointment",
  "task",
  "other",
  "google",
  "social",
];

export const CALENDAR_EVENT_KIND_LABELS: Record<CalendarEventKind, string> = {
  appointment: "Appointments",
  task: "Tasks",
  other: "Other",
  google: "Google Calendar",
  social: "Social",
};

export const CALENDAR_EVENT_COLORS: Record<CalendarEventKind, string> = {
  appointment: "#A855F7",
  task: "#F97316",
  other: "#22C55E",
  google: "#4285F4",
  social: "#BCC256",
};

export interface CalendarEvent {
  id: string;
  kind: CalendarEventKind;
  title: string;
  subtitle: string | null;
  start: string;
  end: string;
  allDay: boolean;
  href: string | null;
}

export function eventColor(kind: CalendarEventKind): string {
  return CALENDAR_EVENT_COLORS[kind];
}

const LIGHT_EVENT_KINDS = new Set<CalendarEventKind>(["social"]);

export function eventTextColor(kind: CalendarEventKind): string {
  return LIGHT_EVENT_KINDS.has(kind) ? "#022342" : "#fff";
}
