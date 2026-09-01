import type { CalendarEventKind, CalendarView } from "@/lib/calendar/calendar-types";
import { CALENDAR_EVENT_KINDS } from "@/lib/calendar/calendar-types";
import { parseIsoDate, toIsoDate } from "@/lib/calendar/calendar-date";

export interface CalendarParams {
  view: CalendarView;
  date: string;
  filters: CalendarEventKind[];
}

const VIEWS: CalendarView[] = ["day", "week", "month", "agenda"];

function readParam(value: string | string[] | undefined): string {
  return typeof value === "string" ? value : "";
}

export function parseCalendarParams(
  searchParams: Record<string, string | string[] | undefined>,
): CalendarParams {
  const viewRaw = readParam(searchParams.view);
  const view = VIEWS.includes(viewRaw as CalendarView)
    ? (viewRaw as CalendarView)
    : "month";

  const dateRaw = readParam(searchParams.date);
  const date =
    /^\d{4}-\d{2}-\d{2}$/.test(dateRaw) ? dateRaw : toIsoDate(new Date());

  const filtersRaw = readParam(searchParams.filters);
  const filters = filtersRaw
    ? filtersRaw
        .split(",")
        .filter((value): value is CalendarEventKind =>
          CALENDAR_EVENT_KINDS.includes(value as CalendarEventKind),
        )
    : [...CALENDAR_EVENT_KINDS];

  return {
    view,
    date,
    filters: filters.length > 0 ? filters : [...CALENDAR_EVENT_KINDS],
  };
}

export function buildCalendarQuery(params: Partial<CalendarParams>): string {
  const qs = new URLSearchParams();
  if (params.view && params.view !== "month") qs.set("view", params.view);
  if (params.date) qs.set("date", params.date);
  if (params.filters) {
    const all =
      params.filters.length === CALENDAR_EVENT_KINDS.length &&
      CALENDAR_EVENT_KINDS.every((kind) => params.filters!.includes(kind));
    if (!all) qs.set("filters", params.filters.join(","));
  }
  const str = qs.toString();
  return str ? `?${str}` : "";
}

export function anchorDate(params: CalendarParams): Date {
  return parseIsoDate(params.date);
}
