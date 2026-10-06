import type { EmailPurpose } from "@/lib/email/email-purpose";
import { ensureEmailSentActivity } from "@/lib/email/email-sent-activity";
import type { EmailRecipient } from "@/lib/email/email-types";
import { beginOutboundEmail, recordOutboundEmailOutcome } from "@/lib/email/outbound-email-ledger";
import { getResendSender, isResendEmailConfigured, reosEmailTags, sendResendMessage } from "@/lib/email/resend";
import { outcomeOf } from "@/lib/messaging/provider-outcome";

export type LedgeredEmailResult =
  | { status: "sent"; emailId: string; providerMessageId: string | null; deduplicated: boolean }
  /** Resend refused it; the record is failed and the same key may try again. */
  | { status: "failed"; emailId: string; error: string }
  /** It may have been sent: the record is unknown, or still pending (its outcome couldn't be saved). Never resent. */
  | { status: "unknown" | "pending"; emailId: string; error: string }
  /** Nothing was recorded or sent. */
  | { status: "not_sent"; kind: "config" | "transient"; error: string }
  /** The key already names an email with different content. */
  | { status: "conflict"; emailId: string };

export const NOT_CONFIGURED_ERROR = "Email sending is not configured for this workspace yet.";
const UNRESOLVED_ERROR = "An earlier attempt at this email wasn't confirmed, so it wasn't sent again.";
const OUTCOME_NOT_SAVED_ERROR = "REOS couldn't record Resend's answer, so this email isn't confirmed; it may have been sent.";

/**
 * One keyed email from an agent, through the crm_emails outbound record: the
 * row is written as pending (with its thread) before Resend is called, so an
 * email Resend accepts always has a record, then gets Resend's answer. A repeat
 * of a sent key returns it without sending; a pending or unknown key is never
 * resent; a failed key is claimed back and sent again. When Resend's answer
 * can't be saved the row stays pending, never sent. The email is tagged with
 * its row id, so Resend's signed events can settle the row later. Its "Email
 * sent" activity is owed from the moment the row is sent and written (once)
 * here, by a later repeat, by a Resend event, or by the repair run.
 */
export async function sendLedgeredEmail(params: {
  tenantId: string;
  contactId: string | null;
  userId: string | null;
  opportunityId: string | null;
  idempotencyKey: string;
  purpose: EmailPurpose;
  threadId: string;
  to: EmailRecipient[];
  cc: EmailRecipient[];
  subject: string;
  bodyHtml: string;
  replyTo: string;
  agentName: string;
  headers?: Record<string, string>;
  contentHash?: string;
  metadata: Record<string, unknown>;
}): Promise<LedgeredEmailResult> {
  const sender = getResendSender();
  if (!sender || !(await isResendEmailConfigured())) {
    return { status: "not_sent", kind: "config", error: NOT_CONFIGURED_ERROR };
  }

  const attempt = await beginOutboundEmail({
    tenantId: params.tenantId,
    contactId: params.contactId,
    userId: params.userId,
    opportunityId: params.opportunityId,
    idempotencyKey: params.idempotencyKey,
    purpose: params.purpose,
    threadId: params.threadId,
    fromEmail: sender.email,
    fromName: params.agentName.trim() || sender.name || "REOS",
    to: params.to,
    cc: params.cc,
    subject: params.subject,
    bodyHtml: params.bodyHtml,
    metadata: { ...params.metadata, reply_to: params.replyTo },
    contentHash: params.contentHash,
  });
  switch (attempt.status) {
    case "error":
      return { status: "not_sent", kind: "transient", error: attempt.error };
    case "conflict":
      return { status: "conflict", emailId: attempt.emailId };
    case "already_sent":
      await ensureEmailSentActivity(params.tenantId, attempt.emailId);
      return { status: "sent", emailId: attempt.emailId, providerMessageId: attempt.providerMessageId, deduplicated: true };
    case "unresolved":
      return { status: attempt.sendStatus, emailId: attempt.emailId, error: UNRESOLVED_ERROR };
  }

  const result = await sendResendMessage({
    to: params.to,
    cc: params.cc,
    subject: params.subject,
    bodyHtml: params.bodyHtml,
    replyTo: params.replyTo,
    agentName: params.agentName,
    headers: params.headers,
    idempotencyKey: params.idempotencyKey,
    tags: reosEmailTags(attempt.emailId),
  });
  const outcome = outcomeOf(result);
  const recorded = await recordOutboundEmailOutcome({ tenantId: params.tenantId, emailId: attempt.emailId, outcome });
  if (!recorded.recorded) return { status: "pending", emailId: attempt.emailId, error: OUTCOME_NOT_SAVED_ERROR };
  if (recorded.status !== "sent") {
    return { status: recorded.status, emailId: attempt.emailId, error: outcome.status === "sent" ? OUTCOME_NOT_SAVED_ERROR : outcome.error };
  }
  await ensureEmailSentActivity(params.tenantId, attempt.emailId);
  if (!recorded.transitioned) {
    return { status: "sent", emailId: attempt.emailId, providerMessageId: recorded.providerMessageId, deduplicated: false };
  }
  const providerMessageId = outcome.status === "sent" ? outcome.providerMessageId : recorded.providerMessageId;
  return { status: "sent", emailId: attempt.emailId, providerMessageId, deduplicated: false };
}
