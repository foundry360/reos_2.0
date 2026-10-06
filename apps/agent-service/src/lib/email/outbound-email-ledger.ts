import type { EmailPurpose } from "@/lib/email/email-purpose";
import { buildEmailSnippet, htmlToPlainText } from "@/lib/email/email-utils";
import type { EmailRecipient } from "@/lib/email/email-types";
import type { OutboundOutcome } from "@/lib/messaging/provider-outcome";
import { getSupabaseAdmin } from "@/lib/supabase/admin";

/**
 * crm_emails rows as the record of each keyed outbound email (migration 065),
 * with the same contract as outbound messages (outbound-messages.ts): the row
 * is written as pending before the provider is called, then gets the
 * provider's answer. A repeat of the same key returns a sent row instead of
 * sending again, reports a pending or unknown row as unresolved (never
 * resent), and claims only a failed row back to pending for another attempt.
 */

export type OutboundEmailAttempt =
  | { status: "ready"; emailId: string }
  | { status: "already_sent"; emailId: string; providerMessageId: string | null }
  | { status: "unresolved"; emailId: string; sendStatus: "pending" | "unknown" }
  /** The key is already used by an email with different content: nothing is sent or changed. */
  | { status: "conflict"; emailId: string }
  | { status: "error"; error: string };

const MAX_ERROR_LENGTH = 500;

export async function beginOutboundEmail(params: {
  tenantId: string;
  /** The contact the email is to; null for email to REOS users. */
  contactId: string | null;
  /** The team member sending it; null for system email. */
  userId?: string | null;
  opportunityId?: string | null;
  idempotencyKey: string;
  purpose: EmailPurpose;
  threadId: string;
  fromEmail: string;
  fromName: string | null;
  to: EmailRecipient[];
  cc?: EmailRecipient[];
  subject: string;
  bodyHtml: string;
  metadata: Record<string, unknown>;
  /**
   * Binds the key to this content: a repeat of the key with a different hash
   * is a conflict, never a send. Without it, a failed row is retried with the
   * content of the retry.
   */
  contentHash?: string;
}): Promise<OutboundEmailAttempt> {
  const db = getSupabaseAdmin();
  if (!db) return { status: "error", error: "Email storage is not configured, so the email wasn't sent." };
  const key = params.idempotencyKey;
  const content = {
    to_recipients: params.to,
    cc_recipients: params.cc ?? [],
    subject: params.subject,
    body_html: params.bodyHtml,
    body_text: htmlToPlainText(params.bodyHtml),
    snippet: buildEmailSnippet(params.bodyHtml),
    metadata: {
      ...params.metadata,
      purpose: params.purpose,
      ...(params.contentHash ? { content_hash: params.contentHash } : {}),
    },
  };

  const { data, error } = await db
    .from("crm_emails")
    .insert({
      tenant_id: params.tenantId,
      contact_id: params.contactId,
      user_id: params.userId ?? null,
      opportunity_id: params.opportunityId ?? null,
      provider: "resend",
      thread_id: params.threadId,
      direction: "outbound",
      from_email: params.fromEmail,
      from_name: params.fromName,
      status: "pending",
      idempotency_key: key,
      ...content,
    })
    .select("id")
    .single();
  if (!error && data?.id) return { status: "ready", emailId: data.id };
  if (error?.code !== "23505") {
    console.error("Outbound email record error:", error?.code ?? "no row");
    return { status: "error", error: "The email couldn't be recorded, so it wasn't sent." };
  }

  const existing = async () => {
    const { data: row, error: readError } = await db
      .from("crm_emails")
      .select("id, status, provider_message_id, metadata")
      .eq("tenant_id", params.tenantId)
      .eq("idempotency_key", key)
      .maybeSingle();
    if (readError || !row) return null;
    return row as { id: string; status: string | null; provider_message_id: string | null; metadata: Record<string, unknown> | null };
  };

  let row = await existing();
  if (row && params.contentHash && row.metadata?.content_hash !== params.contentHash) {
    return { status: "conflict", emailId: row.id };
  }
  if (row?.status === "failed") {
    const { data: claimed } = await db
      .from("crm_emails")
      .update({ status: "pending", send_error: null, ...content })
      .eq("tenant_id", params.tenantId)
      .eq("id", row.id)
      .eq("status", "failed")
      .select("id");
    if ((claimed?.length ?? 0) > 0) return { status: "ready", emailId: row.id };
    row = await existing();
    if (row && params.contentHash && row.metadata?.content_hash !== params.contentHash) {
      return { status: "conflict", emailId: row.id };
    }
  }
  if (!row) return { status: "error", error: "The earlier attempt at this email couldn't be read, so it wasn't sent." };
  if (row.status === "sent") {
    return { status: "already_sent", emailId: row.id, providerMessageId: row.provider_message_id };
  }
  return { status: "unresolved", emailId: row.id, sendStatus: row.status === "pending" ? "pending" : "unknown" };
}

export type RecordedEmailOutcome =
  /**
   * The row holds this status. `transitioned` is false when a Resend event
   * settled it first (that path wrote any activity), so the caller must not.
   */
  | { recorded: true; status: "sent" | "failed" | "unknown"; transitioned: boolean; providerMessageId: string | null }
  | { recorded: false };

/**
 * Records the provider's answer on a pending row; Resend's own acceptance of
 * this request also settles a row already marked unknown. When a signed Resend
 * event settled the row first, its status is returned untransitioned. Returns
 * recorded: false when it couldn't be recorded; the row then stays pending,
 * which reads as unconfirmed, never sent.
 */
export async function recordOutboundEmailOutcome(params: {
  tenantId: string;
  emailId: string;
  outcome: OutboundOutcome;
}): Promise<RecordedEmailOutcome> {
  const db = getSupabaseAdmin();
  if (!db) return { recorded: false };
  const { outcome } = params;
  const settleable = outcome.status === "sent" ? ["pending", "unknown"] : ["pending"];
  const update = (values: Record<string, unknown>) =>
    db
      .from("crm_emails")
      .update(values)
      .eq("tenant_id", params.tenantId)
      .eq("id", params.emailId)
      .in("status", settleable)
      .select("id, provider_message_id");

  const sentAt = new Date().toISOString();
  let { data, error } =
    outcome.status === "sent"
      ? await update({ status: "sent", provider_message_id: outcome.providerMessageId, sent_at: sentAt, send_error: null })
      : await update({ status: outcome.status, send_error: outcome.error.slice(0, MAX_ERROR_LENGTH) });

  // The provider id is unique per tenant and provider. A repeat is recorded as sent without it, never dropped.
  if (error?.code === "23505" && outcome.status === "sent") {
    ({ data, error } = await update({
      status: "sent",
      provider_message_id: null,
      sent_at: sentAt,
      send_error: "The provider returned an email id already recorded on another email.",
    }));
  }
  const updated = data?.[0] as { provider_message_id: string | null } | undefined;
  if (!error && updated) {
    return { recorded: true, status: outcome.status, transitioned: true, providerMessageId: updated.provider_message_id };
  }

  if (!error) {
    const { data: row } = await db
      .from("crm_emails")
      .select("status, provider_message_id")
      .eq("tenant_id", params.tenantId)
      .eq("id", params.emailId)
      .maybeSingle();
    const current = row as { status: string | null; provider_message_id: string | null } | null;
    if (current?.status === "sent" || (current?.status === "unknown" && outcome.status === "unknown")) {
      return { recorded: true, status: current.status, transitioned: false, providerMessageId: current.provider_message_id };
    }
  }
  console.error("Outbound email outcome not recorded:", error?.code ?? "no pending row", outcome.status);
  return { recorded: false };
}