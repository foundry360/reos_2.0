import { calendarGridScrollTopPx } from "@/lib/calendar/calendar-date";

export function scrollCalendarTimeGridToDefault(el: HTMLDivElement | null) {
  if (!el) return;
  el.scrollTop = calendarGridScrollTopPx();
}
