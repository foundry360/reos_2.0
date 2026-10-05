/**
 * Tells the contacts trigger (capture_lead_status_event) who is changing a lead's
 * status, via PostgREST request headers that are visible only to that request's
 * transaction. The database accepts these headers from the service role only;
 * signed-in users are always recorded as themselves.
 *
 * Pure module (no app imports) so it runs under node --test.
 */

export const STATUS_ORIGINS = ["user", "ai_agent", "system", "journey", "import", "merge"] as const;
export type StatusOrigin = (typeof STATUS_ORIGINS)[number];

export const STATUS_ORIGIN_HEADER = "x-reos-origin";
export const STATUS_ACTOR_HEADER = "x-reos-actor-user-id";
export const STATUS_RUN_HEADER = "x-reos-origin-run-id";

export interface StatusOriginContext {
  origin: StatusOrigin;
  actorUserId?: string | null;
  originRunId?: string | null;
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Only allowed origins and well-formed UUIDs become headers; anything else is dropped. */
export function statusOriginHeaders(context: StatusOriginContext): Record<string, string> {
  if (!(STATUS_ORIGINS as readonly string[]).includes(context.origin)) return {};
  const headers: Record<string, string> = { [STATUS_ORIGIN_HEADER]: context.origin };
  if (context.actorUserId && UUID_PATTERN.test(context.actorUserId)) {
    headers[STATUS_ACTOR_HEADER] = context.actorUserId;
  }
  if (context.originRunId && UUID_PATTERN.test(context.originRunId)) {
    headers[STATUS_RUN_HEADER] = context.originRunId;
  }
  return headers;
}

/** Adds the origin headers to a Supabase query before it is sent. */
export function withStatusOrigin<Query extends { setHeader(name: string, value: string): Query }>(
  query: Query,
  context: StatusOriginContext,
): Query {
  let tagged = query;
  for (const [name, value] of Object.entries(statusOriginHeaders(context))) {
    tagged = tagged.setHeader(name, value);
  }
  return tagged;
}
