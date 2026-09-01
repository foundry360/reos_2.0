import { createClient } from "@/lib/supabase/server";
import { personBasePath, type PersonKind } from "@/lib/crm/person-kind";
import type { CalendarEvent, CalendarEventKind } from "@/lib/calendar/calendar-types";
import { endOfDay, startOfDay } from "@/lib/calendar/calendar-date";
import { listGoogleCalendarEvents } from "@/lib/google/calendar";

const APPOINTMENT_MINUTES = 30;
const TASK_DEFAULT_MINUTES = 30;

function personName(first: string | null, last: string | null): string | null {
  const name = [first?.trim(), last?.trim()].filter(Boolean).join(" ");
  return name || null;
}

function personHref(recordType: string | null | undefined, contactId: string): string {
  const kind: PersonKind = recordType === "contact" ? "contact" : "lead";
  return `${personBasePath(kind)}/${contactId}`;
}

function overlapsRange(
  start: Date,
  end: Date,
  rangeStart: Date,
  rangeEnd: Date,
): boolean {
  return start <= rangeEnd && end >= rangeStart;
}

function taskEventTimes(row: {
  start_at?: string | null;
  end_at?: string | null;
  due_at?: string | null;
}): { start: Date; end: Date; allDay: boolean } | null {
  if (row.start_at) {
    const start = new Date(row.start_at);
    const end = row.end_at
      ? new Date(row.end_at)
      : new Date(start.getTime() + TASK_DEFAULT_MINUTES * 60 * 1000);
    return { start, end, allDay: false };
  }
  if (row.due_at) {
    const start = new Date(row.due_at);
    const end = new Date(start.getTime() + TASK_DEFAULT_MINUTES * 60 * 1000);
    return { start, end, allDay: false };
  }
  return null;
}

export async function fetchCalendarEvents(
  tenantId: string,
  rangeStart: Date,
  rangeEnd: Date,
  filters: CalendarEventKind[],
): Promise<CalendarEvent[]> {
  const supabase = await createClient();
  const events: CalendarEvent[] = [];
  const filterSet = new Set(filters);

  if (filterSet.has("task")) {
    const taskSelectWithTimes = `
      id, title, status, due_at, start_at, end_at,
      contact_id,
      contacts ( id, first_name, last_name, record_type ),
      opportunities ( name )
    `;
    const taskSelectLegacy = `
      id, title, status, due_at,
      contact_id,
      contacts ( id, first_name, last_name, record_type ),
      opportunities ( name )
    `;

    let taskRows:
      | {
          id: string;
          title: string;
          status: string;
          due_at: string | null;
          start_at?: string | null;
          end_at?: string | null;
          contact_id: string | null;
          contacts:
            | {
                id: string;
                first_name: string | null;
                last_name: string | null;
                record_type: string | null;
              }
            | {
                id: string;
                first_name: string | null;
                last_name: string | null;
                record_type: string | null;
              }[]
            | null;
          opportunities:
            | { name: string | null }
            | { name: string | null }[]
            | null;
        }[]
      | null = null;

    const withTimes = await supabase
      .from("tasks")
      .select(taskSelectWithTimes)
      .eq("tenant_id", tenantId)
      .order("due_at", { ascending: true, nullsFirst: false })
      .limit(500);

    if (withTimes.error && /start_at|end_at|schema cache|column/i.test(withTimes.error.message)) {
      const legacy = await supabase
        .from("tasks")
        .select(taskSelectLegacy)
        .eq("tenant_id", tenantId)
        .order("due_at", { ascending: true, nullsFirst: false })
        .limit(500);
      if (!legacy.error) taskRows = legacy.data;
    } else if (!withTimes.error) {
      taskRows = withTimes.data;
    }

    for (const row of taskRows ?? []) {
      const times = taskEventTimes(row);
      if (!times || !overlapsRange(times.start, times.end, rangeStart, rangeEnd)) continue;

      const contact = Array.isArray(row.contacts) ? row.contacts[0] : row.contacts;
      const opportunity = Array.isArray(row.opportunities)
        ? row.opportunities[0]
        : row.opportunities;
      const contactName = contact
        ? personName(contact.first_name, contact.last_name)
        : null;

      events.push({
        id: `task:${row.id}`,
        kind: "task",
        title: row.title,
        subtitle: contactName ?? opportunity?.name?.trim() ?? null,
        start: times.start.toISOString(),
        end: times.end.toISOString(),
        allDay: times.allDay,
        href: "/tasks",
      });
    }
  }

  if (filterSet.has("appointment")) {
    const { data: activityRows, error } = await supabase
      .from("contact_activities")
      .select(
        `
        id, title, body, activity_type, occurred_at, contact_id,
        contacts ( first_name, last_name, record_type )
      `,
      )
      .eq("tenant_id", tenantId)
      .in("activity_type", ["appointment", "meeting"])
      .gte("occurred_at", rangeStart.toISOString())
      .lte("occurred_at", rangeEnd.toISOString())
      .order("occurred_at", { ascending: true })
      .limit(500);

    if (error) {
      console.error("calendar appointments failed:", error.message);
    } else {
      for (const row of activityRows ?? []) {
        const start = new Date(row.occurred_at);
        const end = new Date(start.getTime() + APPOINTMENT_MINUTES * 60 * 1000);
        const contact = Array.isArray(row.contacts) ? row.contacts[0] : row.contacts;
        const contactName = contact
          ? personName(contact.first_name, contact.last_name)
          : null;

        events.push({
          id: `activity:${row.id}`,
          kind: "appointment",
          title: row.title,
          subtitle: contactName ?? row.body?.trim() ?? null,
          start: start.toISOString(),
          end: end.toISOString(),
          allDay: false,
          href: row.contact_id
            ? personHref(contact?.record_type, row.contact_id)
            : null,
        });
      }
    }
  }

  if (filterSet.has("other")) {
    const { data: oppRows, error } = await supabase
      .from("opportunities")
      .select(
        `
        id, name, expected_close_date, contact_id,
        contacts ( first_name, last_name, record_type )
      `,
      )
      .eq("tenant_id", tenantId)
      .not("expected_close_date", "is", null)
      .gte("expected_close_date", toDateOnly(rangeStart))
      .lte("expected_close_date", toDateOnly(rangeEnd))
      .order("expected_close_date", { ascending: true })
      .limit(500);

    if (error) {
      console.error("calendar opportunity close dates failed:", error.message);
    } else {
      for (const row of oppRows ?? []) {
        const day = parseCloseDate(row.expected_close_date);
        if (!day) continue;
        const start = startOfDay(day);
        const end = endOfDay(day);
        if (!overlapsRange(start, end, rangeStart, rangeEnd)) continue;

        const contact = Array.isArray(row.contacts) ? row.contacts[0] : row.contacts;
        const contactName = contact
          ? personName(contact.first_name, contact.last_name)
          : null;

        events.push({
          id: `opp-close:${row.id}`,
          kind: "other",
          title: `Close date: ${row.name}`,
          subtitle: contactName,
          start: start.toISOString(),
          end: end.toISOString(),
          allDay: true,
          href: `/opportunities/${row.id}`,
        });
      }
    }
  }

  if (filterSet.has("google")) {
    const googleResult = await listGoogleCalendarEvents({
      tenantId,
      timeMin: rangeStart,
      timeMax: rangeEnd,
    });

    if (!googleResult.ok) {
      console.error("calendar google events failed:", googleResult.error);
    } else {
      const accountLabel = googleResult.calendarLabel;
      for (const row of googleResult.events) {
        const start = new Date(row.start);
        const end = new Date(row.end);
        if (!overlapsRange(start, end, rangeStart, rangeEnd)) continue;

        events.push({
          id: `google:${row.id}`,
          kind: "google",
          title: row.title,
          subtitle: row.subtitle ?? accountLabel,
          start: row.start,
          end: row.end,
          allDay: row.allDay,
          href: null,
        });
      }
    }
  }

  return events.sort(
    (a, b) => new Date(a.start).getTime() - new Date(b.start).getTime(),
  );
}

function toDateOnly(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function parseCloseDate(value: string | null): Date | null {
  if (!value) return null;
  const [y, m, d] = value.split("-").map(Number);
  if (!y || !m || !d) return null;
  return new Date(y, m - 1, d);
}
