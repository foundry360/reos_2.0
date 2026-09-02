"use server";

import type { EmailRecipient } from "@/lib/email/email-types";
import { htmlToPlainText } from "@/lib/email/email-utils";
import { getSupabaseAdmin } from "@/lib/supabase/admin";
import { runEmailIntelligencePipeline } from "@/lib/email/email-intelligence-store";

/** Record an inbound email and run signal analysis. Used by Gmail inbound sync. */
export async function recordInboundCrmEmail(params: {
  tenantId: string;
  userId?: string | null;
  contactId: string;
  opportunityId?: string | null;
  providerMessageId?: string | null;
  threadId?: string | null;
  fromEmail: string;
  fromName?: string | null;
  toRecipients: EmailRecipient[];
  ccRecipients?: EmailRecipient[];
  subject: string;
  bodyHtml?: string | null;
  bodyText?: string | null;
  snippet?: string | null;
  receivedAt?: string;
}): Promise<{ emailId: string } | null> {
  const db = getSupabaseAdmin();
  if (!db) return null;

  const bodyText =
    params.bodyText?.trim() ||
    (params.bodyHtml ? htmlToPlainText(params.bodyHtml) : null);
  const receivedAt = params.receivedAt ?? new Date().toISOString();

  if (params.providerMessageId) {
    const { data: existing } = await db
      .from("crm_emails")
      .select("id")
      .eq("tenant_id", params.tenantId)
      .eq("provider", "gmail")
      .eq("provider_message_id", params.providerMessageId)
      .maybeSingle();
    if (existing) return { emailId: existing.id };
  }

  const { data: row, error } = await db
    .from("crm_emails")
    .insert({
      tenant_id: params.tenantId,
      user_id: params.userId ?? null,
      contact_id: params.contactId,
      opportunity_id: params.opportunityId ?? null,
      provider: "gmail",
      provider_message_id: params.providerMessageId ?? null,
      thread_id: params.threadId ?? null,
      direction: "inbound",
      from_email: params.fromEmail,
      from_name: params.fromName ?? null,
      to_recipients: params.toRecipients,
      cc_recipients: params.ccRecipients ?? [],
      subject: params.subject,
      body_html: params.bodyHtml ?? null,
      body_text: bodyText,
      snippet: params.snippet ?? bodyText?.slice(0, 240) ?? null,
      status: "received",
      received_at: receivedAt,
    })
    .select("id")
    .single();

  if (error || !row) {
    console.error("recordInboundCrmEmail failed:", error?.message);
    return null;
  }

  await runEmailIntelligencePipeline({
    emailId: row.id,
    tenantId: params.tenantId,
    contactId: params.contactId,
    opportunityId: params.opportunityId ?? null,
    direction: "inbound",
    subject: params.subject,
    bodyHtml: params.bodyHtml ?? null,
    bodyText,
    snippet: params.snippet ?? null,
  });

  return { emailId: row.id };
}
