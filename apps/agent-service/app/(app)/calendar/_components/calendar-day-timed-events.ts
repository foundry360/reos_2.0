import {
  layoutTimedEventOnGrid,
  layoutTimedEventOverlaps,
  minutesFromMidnight,
} from "@/lib/calendar/calendar-date";
import type { CalendarEvent } from "@/lib/calendar/calendar-types";

export function layoutDayTimedEvents(dayEvents: CalendarEvent[], day: Date) {
  const dayStart = new Date(day.getFullYear(), day.getMonth(), day.getDate());
  const dayEnd = new Date(day.getFullYear(), day.getMonth(), day.getDate(), 23, 59, 59, 999);

  const slots = dayEvents
    .filter((event) => !event.allDay)
    .map((event) => {
      const start = new Date(event.start);
      const end = new Date(event.end);
      const clipStart = start < dayStart ? dayStart : start;
      const clipEnd = end > dayEnd ? dayEnd : end;
      const { topMin, heightMin } = layoutTimedEventOnGrid(clipStart, clipEnd);

      return {
        event,
        topMin,
        heightMin,
        id: event.id,
        startMin: minutesFromMidnight(clipStart),
        endMin: minutesFromMidnight(clipEnd),
      };
    });

  return layoutTimedEventOverlaps(slots);
}
