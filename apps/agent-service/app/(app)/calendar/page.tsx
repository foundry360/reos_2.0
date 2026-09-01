import { CalendarShell } from "./_components/calendar-shell";
import { PageHeading } from "@/components/shell/page-heading";
import { IconCalendar } from "@/components/shell/sidebar-nav";
import { fetchCalendarEvents } from "@/lib/calendar/calendar-events";
import { getVisibleRange } from "@/lib/calendar/calendar-date";
import {
  anchorDate,
  parseCalendarParams,
} from "@/lib/calendar/calendar-params";
import { isGoogleCalendarConnected } from "@/lib/google/calendar";
import { resolveCurrentTenant, workspaceUnavailableMessage } from "@/lib/tenant/current-tenant";
import styles from "@/components/shell/shell.module.css";

interface PageProps {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

export default async function CalendarPage({ searchParams }: PageProps) {
  const resolved = await searchParams;
  const params = parseCalendarParams(resolved);
  const { tenantId, reason } = await resolveCurrentTenant();

  if (!tenantId) {
    return (
      <>
        <div className={styles.pageHeader}>
          <PageHeading icon={<IconCalendar />} title="Calendar" tone="accent" />
        </div>
        <p className={styles.empty}>{workspaceUnavailableMessage(reason)}</p>
      </>
    );
  }

  const anchor = anchorDate(params);
  const { start, end } = getVisibleRange(params.view, anchor);
  const [events, googleConnected] = await Promise.all([
    fetchCalendarEvents(tenantId, start, end, params.filters),
    isGoogleCalendarConnected(tenantId),
  ]);

  return (
    <CalendarShell
      params={params}
      events={events}
      googleConnected={googleConnected}
    />
  );
}
