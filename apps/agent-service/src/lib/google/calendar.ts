import { getEnv } from "@/lib/env";
import { getSupabaseAdmin } from "@/lib/supabase/admin";

export type SlotPreference = "morning" | "afternoon" | "any";

export interface CalendarSlot {
  start: string;
  end: string;
  label: string;
}

type CalendarMetadata = {
  access_token?: string;
  refresh_token?: string | null;
  expires_in?: number | null;
  expires_at?: string | null;
  scope?: string | null;
  token_type?: string | null;
  label?: string | null;
  calendar_id?: string | null;
};

const CONSULT_MINUTES = 30;
const SLOT_STEP_MINUTES = 30;
const LOOKAHEAD_DAYS = 7;
const TIME_ZONE = "America/New_York";

function morningWindow(date: Date): { startHour: number; endHour: number } {
  return { startHour: 9, endHour: 12 };
}

function afternoonWindow(date: Date): { startHour: number; endHour: number } {
  return { startHour: 13, endHour: 17 };
}

async function refreshAccessToken(refreshToken: string): Promise<{
  accessToken: string;
  expiresIn: number | null;
} | null> {
  const env = getEnv();
  if (!env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET) return null;

  const response = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: env.GOOGLE_CLIENT_ID,
      client_secret: env.GOOGLE_CLIENT_SECRET,
      refresh_token: refreshToken,
      grant_type: "refresh_token",
    }),
  });

  if (!response.ok) {
    console.error("Google token refresh failed:", await response.text());
    return null;
  }

  const data = (await response.json()) as {
    access_token?: string;
    expires_in?: number;
  };
  if (!data.access_token) return null;
  return {
    accessToken: data.access_token,
    expiresIn: data.expires_in ?? null,
  };
}

async function loadCalendarAccount(tenantId: string): Promise<{
  accessToken: string;
  calendarId: string;
  metadata: CalendarMetadata;
  rowId: string;
} | null> {
  const db = getSupabaseAdmin();
  if (!db) return null;

  const { data } = await db
    .from("channel_accounts")
    .select("id, metadata, status")
    .eq("tenant_id", tenantId)
    .eq("channel", "calendar")
    .eq("status", "connected")
    .maybeSingle();

  if (!data) return null;
  const metadata = (data.metadata ?? {}) as CalendarMetadata;
  let accessToken = metadata.access_token?.trim() ?? "";
  const refreshToken = metadata.refresh_token?.trim() ?? "";
  const expiresAt = metadata.expires_at
    ? new Date(metadata.expires_at).getTime()
    : 0;
  const needsRefresh =
    !accessToken || (expiresAt > 0 && expiresAt < Date.now() + 60_000);

  if (needsRefresh && refreshToken) {
    const refreshed = await refreshAccessToken(refreshToken);
    if (refreshed) {
      accessToken = refreshed.accessToken;
      const expiresAtIso = refreshed.expiresIn
        ? new Date(Date.now() + refreshed.expiresIn * 1000).toISOString()
        : metadata.expires_at;
      await db
        .from("channel_accounts")
        .update({
          metadata: {
            ...metadata,
            access_token: refreshed.accessToken,
            expires_in: refreshed.expiresIn,
            expires_at: expiresAtIso,
          },
        })
        .eq("id", data.id);
    }
  }

  if (!accessToken) return null;
  return {
    accessToken,
    calendarId: metadata.calendar_id?.trim() || "primary",
    metadata,
    rowId: data.id,
  };
}

function formatSlotLabel(startIso: string, timeZone: string): string {
  const start = new Date(startIso);
  return new Intl.DateTimeFormat("en-US", {
    timeZone,
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
  }).format(start);
}

function zonedParts(date: Date, timeZone: string) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    weekday: "short",
  }).formatToParts(date);
  const get = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((p) => p.type === type)?.value ?? "";
  return {
    year: Number(get("year")),
    month: Number(get("month")),
    day: Number(get("day")),
    hour: Number(get("hour") === "24" ? "0" : get("hour")),
    minute: Number(get("minute")),
    weekday: get("weekday"),
  };
}

/** Build a Date for a local wall time in TIME_ZONE (approx via iterative offset). */
function dateInTimeZone(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  timeZone: string,
): Date {
  // Start from UTC guess and adjust
  let guess = new Date(Date.UTC(year, month - 1, day, hour, minute, 0));
  for (let i = 0; i < 3; i++) {
    const parts = zonedParts(guess, timeZone);
    const asUtc = Date.UTC(
      parts.year,
      parts.month - 1,
      parts.day,
      parts.hour,
      parts.minute,
      0,
    );
    const desired = Date.UTC(year, month - 1, day, hour, minute, 0);
    guess = new Date(guess.getTime() + (desired - asUtc));
  }
  return guess;
}

function isWeekend(weekday: string): boolean {
  return weekday === "Sat" || weekday === "Sun";
}

function overlapsBusy(
  startMs: number,
  endMs: number,
  busy: Array<{ start: number; end: number }>,
): boolean {
  return busy.some((b) => startMs < b.end && endMs > b.start);
}

export async function getAvailableConsultSlots(params: {
  tenantId: string;
  preference?: SlotPreference;
  limit?: number;
  _retried?: boolean;
}): Promise<
  | { ok: true; slots: CalendarSlot[]; timeZone: string }
  | { ok: false; error: string }
> {
  const account = await loadCalendarAccount(params.tenantId);
  if (!account) {
    return {
      ok: false,
      error:
        "Google Calendar is not connected for this account. Connect it in Admin → Connections.",
    };
  }

  const preference = params.preference ?? "any";
  const limit = Math.min(Math.max(params.limit ?? 3, 1), 5);
  const timeMin = new Date();
  const timeMax = new Date(
    timeMin.getTime() + LOOKAHEAD_DAYS * 24 * 60 * 60 * 1000,
  );

  const freeBusyRes = await fetch(
    "https://www.googleapis.com/calendar/v3/freeBusy",
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${account.accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        timeMin: timeMin.toISOString(),
        timeMax: timeMax.toISOString(),
        timeZone: TIME_ZONE,
        items: [{ id: account.calendarId }],
      }),
    },
  );

  if (!freeBusyRes.ok) {
    const body = await freeBusyRes.text();
    console.error("Google FreeBusy failed:", body);
    // Stale token without expires_at: try one refresh + retry.
    if (freeBusyRes.status === 401 && account.metadata.refresh_token) {
      const refreshed = await refreshAccessToken(account.metadata.refresh_token);
      if (refreshed) {
        const db = getSupabaseAdmin();
        if (db) {
          await db
            .from("channel_accounts")
            .update({
              metadata: {
                ...account.metadata,
                access_token: refreshed.accessToken,
                expires_in: refreshed.expiresIn,
                expires_at: refreshed.expiresIn
                  ? new Date(
                      Date.now() + refreshed.expiresIn * 1000,
                    ).toISOString()
                  : null,
              },
            })
            .eq("id", account.rowId);
        }
        return getAvailableConsultSlots(params);
      }
    }
    return { ok: false, error: "Could not read calendar availability." };
  }

  const freeBusy = (await freeBusyRes.json()) as {
    calendars?: Record<
      string,
      { busy?: Array<{ start?: string; end?: string }> }
    >;
  };
  const busyRaw =
    freeBusy.calendars?.[account.calendarId]?.busy ??
    freeBusy.calendars?.primary?.busy ??
    [];
  const busy = busyRaw
    .map((b) => ({
      start: b.start ? new Date(b.start).getTime() : 0,
      end: b.end ? new Date(b.end).getTime() : 0,
    }))
    .filter((b) => b.start && b.end);

  const slots: CalendarSlot[] = [];
  const now = Date.now() + 60 * 60 * 1000; // at least 1h from now

  for (let dayOffset = 0; dayOffset < LOOKAHEAD_DAYS && slots.length < limit; dayOffset++) {
    const probe = new Date(timeMin.getTime() + dayOffset * 24 * 60 * 60 * 1000);
    const parts = zonedParts(probe, TIME_ZONE);
    if (isWeekend(parts.weekday)) continue;

    const windows: Array<{ startHour: number; endHour: number }> = [];
    if (preference === "morning" || preference === "any") {
      windows.push(morningWindow(probe));
    }
    if (preference === "afternoon" || preference === "any") {
      windows.push(afternoonWindow(probe));
    }

    for (const win of windows) {
      for (let hour = win.startHour; hour < win.endHour; hour++) {
        for (let minute = 0; minute < 60; minute += SLOT_STEP_MINUTES) {
          if (hour === win.endHour - 1 && minute + CONSULT_MINUTES > 60) continue;
          const start = dateInTimeZone(
            parts.year,
            parts.month,
            parts.day,
            hour,
            minute,
            TIME_ZONE,
          );
          const end = new Date(start.getTime() + CONSULT_MINUTES * 60 * 1000);
          const endParts = zonedParts(end, TIME_ZONE);
          if (
            endParts.day !== parts.day ||
            endParts.hour > win.endHour ||
            (endParts.hour === win.endHour && endParts.minute > 0)
          ) {
            continue;
          }
          if (start.getTime() < now) continue;
          if (overlapsBusy(start.getTime(), end.getTime(), busy)) continue;

          const startIso = start.toISOString();
          slots.push({
            start: startIso,
            end: end.toISOString(),
            label: formatSlotLabel(startIso, TIME_ZONE),
          });
          if (slots.length >= limit) break;
        }
        if (slots.length >= limit) break;
      }
      if (slots.length >= limit) break;
    }
  }

  if (slots.length === 0) {
    return {
      ok: false,
      error: "No open consult slots in the next week for that preference.",
    };
  }

  return { ok: true, slots, timeZone: TIME_ZONE };
}

export async function bookConsultSlot(params: {
  tenantId: string;
  start: string;
  end?: string;
  attendeeEmail?: string | null;
  leadName?: string | null;
  summary?: string | null;
}): Promise<
  | { ok: true; eventId: string; htmlLink: string | null; start: string; end: string }
  | { ok: false; error: string }
> {
  const account = await loadCalendarAccount(params.tenantId);
  if (!account) {
    return {
      ok: false,
      error: "Google Calendar is not connected for this account.",
    };
  }

  const start = new Date(params.start);
  if (Number.isNaN(start.getTime())) {
    return { ok: false, error: "Invalid start time." };
  }
  const end = params.end
    ? new Date(params.end)
    : new Date(start.getTime() + CONSULT_MINUTES * 60 * 1000);
  if (Number.isNaN(end.getTime())) {
    return { ok: false, error: "Invalid end time." };
  }

  const summary =
    params.summary?.trim() ||
    `REOS consult${params.leadName ? ` — ${params.leadName}` : ""}`;

  const body: Record<string, unknown> = {
    summary,
    description: "Booked via REOS Scheduler agent.",
    start: { dateTime: start.toISOString(), timeZone: TIME_ZONE },
    end: { dateTime: end.toISOString(), timeZone: TIME_ZONE },
  };
  const email = params.attendeeEmail?.trim();
  if (email) {
    body.attendees = [{ email }];
  }

  const response = await fetch(
    `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(account.calendarId)}/events?sendUpdates=${email ? "all" : "none"}`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${account.accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    },
  );

  if (!response.ok) {
    const text = await response.text();
    console.error("Google Calendar insert failed:", text);
    return { ok: false, error: "Could not create the calendar event." };
  }

  const data = (await response.json()) as {
    id?: string;
    htmlLink?: string;
  };

  if (!data.id) {
    return { ok: false, error: "Calendar event created without an id." };
  }

  return {
    ok: true,
    eventId: data.id,
    htmlLink: data.htmlLink ?? null,
    start: start.toISOString(),
    end: end.toISOString(),
  };
}
