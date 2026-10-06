import { reosEmailIdFromTags } from "@/lib/email/resend";
import { resendWebhookHeaders, verifyResendWebhook } from "@/lib/email/resend-webhook-signature";
import { getSupabaseAdmin } from "@/lib/supabase/admin";

/**
 * Resend events into the crm_emails record (migration 066). The database
 * function apply_email_provider_event does all of it in one transaction:
 * records the event once per provider event id, finds the email it names (our
 * reos_email_id tag, else the only email with that Resend id), takes the
 * tenant from that email, and settles it. An event never creates an email.
 */

export type ProviderEventResult = "applied" | "stale" | "ignored" | "unmatched" | "mismatch" | "duplicate";

export interface ResendEvent {
  eventId: string;
  type: string;
  providerMessageId: string | null;
  reosEmailId: string | null;
  /** Provider time of the event; null when it isn't one (Resend's record of the email). */
  eventAt: string | null;
  detail: Record<string, string>;
}

const MAX_ID_LENGTH = 200;
const MAX_DETAIL_LENGTH = 200;

function shortString(value: unknown, max = MAX_DETAIL_LENGTH): string | null {
  return typeof value === "string" && value.trim() ? value.trim().slice(0, max) : null;
}

function isoTime(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const time = Date.parse(value);
  return Number.isNaN(time) ? null : new Date(time).toISOString();
}

/** Only classifications are kept: never recipients, subjects, bodies or the payload. */
function eventDetail(type: string, data: Record<string, unknown>): Record<string, string> {
  const detail: Record<string, string> = {};
  const section = (name: string) =>
    data[name] && typeof data[name] === "object" ? (data[name] as Record<string, unknown>) : null;
  if (type === "email.bounced") {
    const bounce = section("bounce");
    const kind = shortString(bounce?.type, 50);
    const subKind = shortString(bounce?.subType, 50);
    if (kind) detail.bounce_type = kind;
    if (subKind) detail.bounce_sub_type = subKind;
  }
  if (type === "email.failed") {
    const reason = shortString(section("failed")?.reason);
    if (reason) detail.reason = reason;
  }
  if (type === "email.suppressed") {
    const kind = shortString(section("suppressed")?.type, 50);
    if (kind) detail.suppressed_type = kind;
  }
  return detail;
}

/** A verified webhook body as an event, or null when it isn't one. */
export function parseResendWebhookEvent(eventId: string, payload: unknown): ResendEvent | null {
  if (!payload || typeof payload !== "object") return null;
  const { type, created_at: createdAt, data } = payload as { type?: unknown; created_at?: unknown; data?: unknown };
  const id = shortString(eventId, MAX_ID_LENGTH);
  const eventType = shortString(type, 100);
  if (!id || !eventType) return null;
  const fields = data && typeof data === "object" ? (data as Record<string, unknown>) : {};
  return {
    eventId: id,
    type: eventType,
    providerMessageId: shortString(fields.email_id, MAX_ID_LENGTH),
    reosEmailId: shortString(reosEmailIdFromTags(fields.tags), MAX_ID_LENGTH),
    eventAt: isoTime(createdAt),
    detail: eventDetail(eventType, fields),
  };
}

export async function applyProviderEvent(
  event: ResendEvent,
): Promise<{ ok: true; result: ProviderEventResult } | { ok: false }> {
  const db = getSupabaseAdmin();
  if (!db) return { ok: false };
  const { data, error } = await db.rpc("apply_email_provider_event", {
    p_provider: "resend",
    p_provider_event_id: event.eventId,
    p_event_type: event.type,
    p_provider_message_id: event.providerMessageId,
    p_reos_email_id: event.reosEmailId,
    p_event_at: event.eventAt,
    p_detail: event.detail,
  });
  if (error || typeof data !== "string") {
    console.error("Email provider event not applied:", error?.code ?? "no result");
    return { ok: false };
  }
  return { ok: true, result: data as ProviderEventResult };
}

export interface WebhookResponse {
  status: number;
  body: Record<string, unknown>;
}

/**
 * One Resend webhook delivery. Responses carry no ids or tenant data. A
 * failure to record answers 500 so Resend redelivers the same event id.
 */
export async function handleResendWebhook(params: {
  secret: string | null | undefined;
  headers: Headers;
  rawBody: string;
}): Promise<WebhookResponse> {
  if (!params.secret?.trim()) {
    console.error("Resend webhook rejected: RESEND_WEBHOOK_SECRET is not configured");
    return { status: 503, body: { error: "Webhook not configured" } };
  }
  const headers = resendWebhookHeaders(params.headers);
  if (!verifyResendWebhook({ secret: params.secret, headers, body: params.rawBody })) {
    console.warn("Resend webhook rejected: invalid signature");
    return { status: 400, body: { error: "Invalid signature" } };
  }

  let payload: unknown;
  try {
    payload = JSON.parse(params.rawBody);
  } catch {
    return { status: 400, body: { error: "Invalid payload" } };
  }
  const event = parseResendWebhookEvent(headers.id ?? "", payload);
  if (!event) return { status: 400, body: { error: "Invalid payload" } };

  const applied = await applyProviderEvent(event);
  if (!applied.ok) return { status: 500, body: { error: "Webhook processing failed" } };
  console.log(`Resend webhook: ${event.type} ${applied.result}`);
  return { status: 200, body: { received: true } };
}
