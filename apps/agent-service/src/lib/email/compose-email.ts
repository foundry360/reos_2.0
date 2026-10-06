import { createHash } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { unsubscribeBlocks, type EmailPurpose } from "@/lib/email/email-purpose";
import type { EmailRecipient } from "@/lib/email/email-types";
import { sendLedgeredEmail } from "@/lib/email/send-ledgered-email";
import { manualEmailUnsubscribeBlock } from "@/lib/email/unsubscribe";
import type { ComposeSendResult } from "@/lib/messaging/compose-draft";

/** A person writing to the contact from the CRM. */
export const CRM_COMPOSE_PURPOSE: EmailPurpose = "conversational";

const DRAFT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_THREAD_ID_LENGTH = 200;

/** The idempotency key of one composed email: per user, per draft. */
export function composeEmailKey(userId: string, draftId: string): string {
  return `compose-email:${userId}:${draftId.toLowerCase()}`;
}

/** The thread of a new composed email, known before it's sent and the same on every retry of the draft. */
export function composeEmailThreadId(draftId: string): string {
  return `compose:${draftId.toLowerCase()}`;
}

export interface ComposedEmail {
  contactId: string | null;
  opportunityId: string | null;
  to: EmailRecipient[];
  cc: EmailRecipient[];
  subject: string;
  bodyHtml: string;
  /** The thread being replied to; null starts a new thread. */
  threadId: string | null;
}

const recipientKey = (recipients: EmailRecipient[]) =>
  recipients.map((recipient) => [recipient.email.trim().toLowerCase(), recipient.name?.trim() || null]);

/** What the draft identity is bound to: who it goes to, where it's filed, and what it says. */
export function composeEmailContentHash(email: ComposedEmail): string {
  return createHash("sha256")
    .update(
      JSON.stringify([
        email.contactId,
        email.opportunityId,
        recipientKey(email.to),
        recipientKey(email.cc),
        email.subject,
        email.bodyHtml,
        email.threadId,
      ]),
    )
    .digest("hex");
}

const DRAFT_CONFLICT: ComposeSendResult = {
  outcome: "draft_conflict",
  error: "This draft was already used for a different email, so it wasn't sent. Send it again as a new email.",
};

/**
 * A team member's email from the CRM composer, as one operation named by its
 * draft: recorded as pending before Resend is called, the same draft and
 * content are the same send (a sent email isn't sent again, a failed one is
 * retried, a pending or unknown one is never resent), and a draft already used
 * for other content is refused. The purpose is always conversational, so the
 * unsubscribe check is the existing conservative one.
 */
export async function sendComposedEmail(
  db: SupabaseClient,
  input: ComposedEmail & {
    tenantId: string;
    userId: string;
    draftId: string;
    replyTo: string;
    agentName: string;
  },
): Promise<ComposeSendResult> {
  if (!DRAFT_ID.test(input.draftId)) {
    return { outcome: "not_attempted", error: "This draft couldn't be identified, so it wasn't sent. Refresh the page and try again." };
  }
  const threadId = input.threadId?.trim() || null;
  if (threadId && threadId.length > MAX_THREAD_ID_LENGTH) {
    return { outcome: "not_attempted", error: "This reply's thread couldn't be identified, so it wasn't sent." };
  }
  const email: ComposedEmail = {
    contactId: input.contactId,
    opportunityId: input.opportunityId,
    to: input.to,
    cc: input.cc,
    subject: input.subject,
    bodyHtml: input.bodyHtml,
    threadId,
  };

  if (unsubscribeBlocks(CRM_COMPOSE_PURPOSE)) {
    const unsubscribed = await manualEmailUnsubscribeBlock(db, {
      tenantId: input.tenantId,
      contactId: email.contactId,
      emails: [...email.to, ...email.cc].map((recipient) => recipient.email),
    });
    if (unsubscribed.blocked) return { outcome: "not_attempted", error: unsubscribed.error };
  }

  const sent = await sendLedgeredEmail({
    tenantId: input.tenantId,
    contactId: email.contactId,
    userId: input.userId,
    opportunityId: email.opportunityId,
    idempotencyKey: composeEmailKey(input.userId, input.draftId),
    purpose: CRM_COMPOSE_PURPOSE,
    threadId: threadId ?? composeEmailThreadId(input.draftId),
    to: email.to,
    cc: email.cc,
    subject: email.subject,
    bodyHtml: email.bodyHtml,
    replyTo: input.replyTo,
    agentName: input.agentName,
    contentHash: composeEmailContentHash(email),
    metadata: {},
  });
  switch (sent.status) {
    case "sent":
      return { outcome: "sent", messageId: sent.emailId };
    case "failed":
      return { outcome: "not_sent", error: sent.error, messageId: sent.emailId };
    case "unknown":
    case "pending":
      return { outcome: "not_confirmed", error: sent.error, messageId: sent.emailId, sendStatus: sent.status };
    case "conflict":
      return DRAFT_CONFLICT;
    case "not_sent":
      return { outcome: "not_attempted", error: sent.error };
  }
}
