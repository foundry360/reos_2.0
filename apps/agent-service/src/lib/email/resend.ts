import { getResendApiKey } from "@/lib/admin/resend";
import { getEnv } from "@/lib/env";
import { isValidEmailAddress } from "@/lib/email/email-utils";
import type { EmailRecipient } from "@/lib/email/email-types";
import { buildResendPayload } from "@/lib/email/resend-payload";
import { failureForStatus, failureForThrown, sendSignal, type ProviderFailure } from "@/lib/messaging/provider-outcome";

export interface ResendSender {
  email: string;
  name: string | null;
}

export function getResendSender(): ResendSender | null {
  const env = getEnv();
  const email = env.RESEND_FROM_EMAIL?.trim().toLowerCase() ?? "";
  if (!email || !isValidEmailAddress(email)) return null;
  return {
    email,
    name: env.RESEND_FROM_NAME?.trim() || null,
  };
}

export async function isResendEmailConfigured(): Promise<boolean> {
  return Boolean((await getResendApiKey()) && getResendSender());
}

export async function sendResendMessage(params: {
  to: EmailRecipient[];
  cc: EmailRecipient[];
  subject: string;
  bodyHtml: string;
  replyTo: string;
  agentName: string;
  /** Extra email headers (List-Unsubscribe on automated email). */
  headers?: Record<string, string>;
  /** Resend replays the first response for a repeated key within 24 hours instead of sending again. */
  idempotencyKey?: string;
  /** Content is plain text; it is base64-encoded for Resend. */
  attachments?: { filename: string; content: string; contentType: string }[];
  /** Resend tags: ASCII letters, digits, underscores and dashes. Every webhook event for the email carries them. */
  tags?: { name: string; value: string }[];
}): Promise<
  | {
      ok: true;
      providerMessageId: string;
      fromEmail: string;
      fromName: string;
    }
  | ProviderFailure
> {
  const apiKey = await getResendApiKey();
  const sender = getResendSender();
  if (!apiKey || !sender) {
    return {
      ok: false,
      outcome: "rejected",
      error:
        "Email sending is not configured for this workspace yet.",
    };
  }

  const { payload, fromName } = buildResendPayload({
    senderEmail: sender.email,
    senderProductName: sender.name || "REOS",
    agentName: params.agentName,
    agentEmail: params.replyTo,
    to: params.to,
    cc: params.cc,
    subject: params.subject,
    bodyHtml: params.bodyHtml,
  });
  const body: Record<string, unknown> = { ...payload };
  if (params.headers) body.headers = params.headers;
  if (params.attachments?.length) {
    body.attachments = params.attachments.map((attachment) => ({
      filename: attachment.filename,
      content: Buffer.from(attachment.content, "utf8").toString("base64"),
      content_type: attachment.contentType,
    }));
  }
  if (params.tags?.length) body.tags = params.tags;
  let response: Response;
  try {
    response = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        ...(params.idempotencyKey ? { "Idempotency-Key": params.idempotencyKey } : {}),
      },
      body: JSON.stringify(body),
      signal: sendSignal(),
    });
  } catch (error) {
    return failureForThrown(error);
  }

  const data = (await response.json().catch(() => null)) as {
    id?: string;
    message?: string;
    name?: string;
  } | null;

  if (!response.ok || !data?.id) {
    console.warn("Resend email send failed:", response.status, data?.name);
    const detail = data?.message?.trim() || "Could not send email through REOS.";
    // 409: the idempotency key was already used (or is in flight), so an earlier attempt may have sent it.
    if (response.status === 409) {
      return { ok: false, outcome: "unknown", error: `Resend didn't confirm the email (${detail}); it may have been sent.` };
    }
    if (response.ok) {
      return { ok: false, outcome: "unknown", error: "Resend accepted the request without an email id; it may have been sent." };
    }
    return failureForStatus(response.status, detail);
  }

  return {
    ok: true,
    providerMessageId: data.id,
    fromEmail: sender.email,
    fromName,
  };
}

/** The tag naming the crm_emails row an email was sent for. */
export const REOS_EMAIL_TAG = "reos_email_id";

export function reosEmailTags(emailId: string): { name: string; value: string }[] {
  return [{ name: REOS_EMAIL_TAG, value: emailId }];
}

/** Resend's tags arrive as an object (webhooks) or a list of name/value pairs. */
export function reosEmailIdFromTags(tags: unknown): string | null {
  let value: unknown = null;
  if (Array.isArray(tags)) {
    value = tags.find((tag) => tag && typeof tag === "object" && (tag as { name?: unknown }).name === REOS_EMAIL_TAG)?.value;
  } else if (tags && typeof tags === "object") {
    value = (tags as Record<string, unknown>)[REOS_EMAIL_TAG];
  }
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

export type ResendEmailRecord =
  | { status: "found"; lastEvent: string | null; reosEmailId: string | null }
  | { status: "not_found" }
  | { status: "unavailable" };

/** Resend's own record of one email it accepted (GET /emails/{id}). */
export async function retrieveResendEmail(providerMessageId: string): Promise<ResendEmailRecord> {
  const apiKey = await getResendApiKey();
  if (!apiKey) return { status: "unavailable" };
  let response: Response;
  try {
    response = await fetch(`https://api.resend.com/emails/${encodeURIComponent(providerMessageId)}`, {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: sendSignal(),
    });
  } catch {
    return { status: "unavailable" };
  }
  if (response.status === 404) return { status: "not_found" };
  if (!response.ok) return { status: "unavailable" };
  const data = (await response.json().catch(() => null)) as { id?: unknown; last_event?: unknown; tags?: unknown } | null;
  if (!data || data.id !== providerMessageId) return { status: "unavailable" };
  return {
    status: "found",
    lastEvent: typeof data.last_event === "string" ? data.last_event : null,
    reosEmailId: reosEmailIdFromTags(data.tags),
  };
}
