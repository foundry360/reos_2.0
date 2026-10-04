import { buildEmailSnippet, htmlToPlainText } from "@/lib/email/email-utils";
import type { EmailRecipient } from "@/lib/email/email-types";
import { logSystemContactActivity } from "@/lib/crm/log-system-activity";
import { getSupabaseAdmin } from "@/lib/supabase/admin";

/**
 * Saves an email that Resend already accepted into crm_emails and logs it on
 * the contact's activity timeline. Returns the crm_emails id, or null if the
 * row couldn't be saved.
 */
export async function recordOutboundEmail(params: {
  tenantId: string;
  /** Sending team member; null for automated (journey) sends. */
  userId: string | null;
  contactId: string | null;
  opportunityId: string | null;
  to: EmailRecipient[];
  cc: EmailRecipient[];
  subject: string;
  bodyHtml: string;
  replyTo: string;
  threadId?: string | null;
  sent: { providerMessageId: string; fromEmail: string; fromName: string };
  metadata?: Record<string, unknown>;
}): Promise<string | null> {
  const db = getSupabaseAdmin();
  if (!db) return null;

  const { tenantId, contactId, opportunityId, subject, bodyHtml, sent } = params;
  const snippet = buildEmailSnippet(bodyHtml);
  const bodyText = htmlToPlainText(bodyHtml);
  const sentAt = new Date().toISOString();
  const threadId = params.threadId?.trim() || `resend:${sent.providerMessageId}`;

  const emailRow = {
    tenant_id: tenantId,
    user_id: params.userId,
    contact_id: contactId,
    opportunity_id: opportunityId,
    provider_message_id: sent.providerMessageId,
    thread_id: threadId,
    direction: "outbound" as const,
    from_email: sent.fromEmail,
    from_name: sent.fromName,
    to_recipients: params.to,
    cc_recipients: params.cc,
    subject,
    body_html: bodyHtml,
    body_text: bodyText,
    snippet,
    status: "sent" as const,
    sent_at: sentAt,
  };
  const metadata = { reply_to: params.replyTo, ...(params.metadata ?? {}) };

  // Prefer provider=resend (migration 043). Until that check constraint is
  // updated, fall back to a compatible provider value and tag metadata.
  let storedProvider: "resend" | "gmail" = "resend";
  let { data: row, error: insertError } = await db
    .from("crm_emails")
    .insert({ ...emailRow, provider: "resend", metadata })
    .select("id")
    .single();

  if (insertError && /crm_emails_provider_check/i.test(insertError.message ?? "")) {
    console.warn(
      "crm_emails provider check rejected resend; saving with compatibility fallback until migration 043 is applied",
    );
    storedProvider = "gmail";
    ({ data: row, error: insertError } = await db
      .from("crm_emails")
      .insert({ ...emailRow, provider: "gmail", metadata: { ...metadata, delivery_provider: "resend" } })
      .select("id")
      .single());
  }

  let emailId = row?.id ?? null;

  if (insertError?.code === "23505" && sent.providerMessageId) {
    const { data: existing } = await db
      .from("crm_emails")
      .select("id")
      .eq("tenant_id", tenantId)
      .eq("provider", storedProvider)
      .eq("provider_message_id", sent.providerMessageId)
      .maybeSingle();

    if (existing) {
      await db
        .from("crm_emails")
        .update({
          contact_id: contactId,
          opportunity_id: opportunityId,
          thread_id: threadId,
          subject,
          body_html: bodyHtml,
          body_text: bodyText,
          snippet,
          sent_at: sentAt,
        })
        .eq("id", existing.id);
      emailId = existing.id;
    }
  }

  if (!emailId) {
    console.error("crm_emails insert failed:", insertError?.message);
    return null;
  }

  if (contactId) {
    await logSystemContactActivity({
      tenantId,
      contactId,
      activityType: "email",
      title: `Email sent: ${subject}`,
      body: snippet,
      relatedEntityType: opportunityId ? "opportunity" : null,
      relatedEntityId: opportunityId,
    });
  }

  return emailId;
}
