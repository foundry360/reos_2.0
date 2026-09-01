"use client";

import { useRouter } from "next/navigation";
import { DropdownSelect } from "@/components/shell/dropdown-select";
import { IconCalendar } from "@/components/shell/sidebar-nav";
import shellStyles from "@/components/shell/shell.module.css";
import {
  addDays,
  addMonths,
  formatMonthYear,
  formatShortMonthDay,
  getVisibleRange,
  parseIsoDate,
  toIsoDate,
} from "@/lib/calendar/calendar-date";
import {
  buildCalendarQuery,
  type CalendarParams,
} from "@/lib/calendar/calendar-params";
import type { CalendarEvent, CalendarEventKind, CalendarView } from "@/lib/calendar/calendar-types";
import { CalendarFilterDropdown } from "./calendar-filter-dropdown";
import { CalendarAgendaView } from "./calendar-agenda-view";
import { CalendarDayView } from "./calendar-day-view";
import { CalendarMonthView } from "./calendar-month-view";
import { CalendarWeekView } from "./calendar-week-view";
import styles from "./calendar.module.css";

const VIEW_LABELS: Record<CalendarView, string> = {
  day: "Day",
  week: "Week",
  month: "Month",
  agenda: "Agenda",
};

interface CalendarShellProps {
  params: CalendarParams;
  events: CalendarEvent[];
  googleConnected: boolean;
}

function periodLabel(view: CalendarView, date: string): string {
  const anchor = parseIsoDate(date);
  if (view === "day") {
    return new Intl.DateTimeFormat("en-US", {
      weekday: "short",
      month: "short",
      day: "numeric",
      year: "numeric",
    })
      .format(anchor)
      .replace(/\b(\w{3})\./g, "$1");
  }
  if (view === "week") {
    const { start, end } = getVisibleRange("week", anchor);
    const sameYear = start.getFullYear() === end.getFullYear();
    const sameMonth = sameYear && start.getMonth() === end.getMonth();
    if (sameMonth) {
      return `${formatShortMonthDay(start)} – ${end.getDate()}, ${end.getFullYear()}`;
    }
    if (sameYear) {
      return `${formatShortMonthDay(start)} – ${formatShortMonthDay(end)}, ${end.getFullYear()}`;
    }
    return `${formatShortMonthDay(start)}, ${start.getFullYear()} – ${formatShortMonthDay(end)}, ${end.getFullYear()}`;
  }
  if (view === "agenda") {
    return `Next 30 days from ${formatShortMonthDay(anchor)}`;
  }
  return formatMonthYear(anchor);
}

function shiftDate(view: CalendarView, date: string, direction: -1 | 1): string {
  const anchor = parseIsoDate(date);
  if (view === "day") return toIsoDate(addDays(anchor, direction));
  if (view === "week") return toIsoDate(addDays(anchor, direction * 7));
  if (view === "agenda") return toIsoDate(addDays(anchor, direction * 30));
  return toIsoDate(addMonths(anchor, direction));
}

export function CalendarShell({ params, events, googleConnected }: CalendarShellProps) {
  const router = useRouter();

  function navigate(next: Partial<CalendarParams>) {
    router.push(`/calendar${buildCalendarQuery({ ...params, ...next })}`);
  }

  function setFilters(filters: CalendarEventKind[]) {
    navigate({ filters });
  }

  function openDay(date: string) {
    navigate({ view: "day", date });
  }

  return (
    <div className={styles.calendarPage}>
      <div className={styles.calendarHeader}>
        <div className={styles.calendarHeaderStart}>
          <div className={shellStyles.pageTitleRow}>
            <span className={shellStyles.pageTitleIcon} aria-hidden>
              <IconCalendar />
            </span>
            <h1 className={shellStyles.pageTitle}>Calendar</h1>
          </div>
          <button
            type="button"
            className={styles.todayBtn}
            onClick={() => navigate({ date: toIsoDate(new Date()) })}
          >
            Today
          </button>
          <div className={styles.navGroup}>
            <button
              type="button"
              className={styles.navBtn}
              aria-label="Previous"
              onClick={() => navigate({ date: shiftDate(params.view, params.date, -1) })}
            >
              ‹
            </button>
            <button
              type="button"
              className={styles.navBtn}
              aria-label="Next"
              onClick={() => navigate({ date: shiftDate(params.view, params.date, 1) })}
            >
              ›
            </button>
          </div>
          <p className={styles.periodLabel}>{periodLabel(params.view, params.date)}</p>
        </div>

        <div className={styles.calendarHeaderEnd}>
          <div className={`${styles.viewDropdown} ${shellStyles.calendarViewDropdown}`}>
            <DropdownSelect
              value={params.view}
              onChange={(view) => navigate({ view: view as CalendarView })}
              options={(Object.keys(VIEW_LABELS) as CalendarView[]).map((view) => ({
                value: view,
                label: VIEW_LABELS[view],
              }))}
              variant="compact"
              ariaLabel="Calendar view"
            />
          </div>
          <CalendarFilterDropdown filters={params.filters} onChange={setFilters} />
        </div>
      </div>

      {params.filters.includes("google") && !googleConnected ? (
        <p className={styles.calendarNotice}>
          Google Calendar is not connected for this workspace. Connect it in Admin → Accounts →
          Connections.
        </p>
      ) : null}

      <div className={styles.calendarBody}>
        {params.view === "month" ? (
          <CalendarMonthView
            anchorDate={params.date}
            events={events}
            onSelectDay={openDay}
          />
        ) : null}
        {params.view === "week" ? (
          <CalendarWeekView
            anchorDate={params.date}
            events={events}
            onSelectDay={openDay}
          />
        ) : null}
        {params.view === "day" ? (
          <CalendarDayView anchorDate={params.date} events={events} />
        ) : null}
        {params.view === "agenda" ? (
          <CalendarAgendaView anchorDate={params.date} events={events} />
        ) : null}
      </div>
    </div>
  );
}
