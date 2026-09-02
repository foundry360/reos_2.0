"use server";

import { revalidatePath } from "next/cache";
import {
  buildEmailSnippet,
  htmlToPlainText,
  parseRecipientList,
} from "@/lib/email/email-utils";
import { persistEmailIntelligence } from "@/lib/email/email-intelligence-store";
import type { SendEmailInput, SendEmailResult } from "@/lib/email/email-types";
import { logSystemContactActivity } from "@/lib/crm/log-system-activity";
import { personBasePath, type PersonKind } from "@/lib/crm/person-kind";
import { sendGmailMessage, loadGmailAccount } from "@/lib/google/gmail";
import { createClient } from "@/lib/supabase/server";
import { getSupabaseAdmin } from "@/lib/supabase/admin";
import { resolveCurrentTenant } from "@/lib/tenant/current-tenant";
import { isPlatformAdmin } from "@/lib/admin/auth";

export async function sendEmailAction(input: SendEmailInput): Promise<SendEmailResult> {
  const subject = input.subject.trim();
  const bodyHtml = input.bodyHtml.trim();
  const toRecipients = parseRecipientList(input.to);
  const ccRecipients = parseRecipientList(input.cc ?? "");

  if (toRecipients.length === 0) {
    return { ok: false, error: "Enter at least one valid recipient." };
  }
  if (!subject) {
    return { ok: false, error: "Subject is required." };
  }
  if (!bodyHtml || !htmlToPlainText(bodyHtml)) {
    return { ok: false, error: "Email body cannot be empty." };
  }

  const { tenantId } = await resolveCurrentTenant();
  if (!tenantId) {
    return { ok: false, error: "Your account is not linked to a workspace yet." };
  }

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { ok: false, error: "You must be signed in to send email." };

  let contactId = input.contactId?.trim() || null;
  let opportunityId = input.opportunityId?.trim() || null;

  if (contactId) {
    const { data: contact } = await supabase
      .from("contacts")
      .select("id, record_type")
      .eq("id", contactId)
      .eq("tenant_id", tenantId)
      .maybeSingle();
    if (!contact) contactId = null;
  }

  if (!contactId && toRecipients.length === 1) {
    const { data: match } = await supabase
      .from("contacts")
      .select("id")
      .eq("tenant_id", tenantId)
      .ilike("email", toRecipients[0].email)
      .maybeSingle();
    contactId = match?.id ?? null;
  }

  if (opportunityId) {
    const { data: opportunity } = await supabase
      .from("opportunities")
      .select("id, contact_id")
      .eq("id", opportunityId)
      .eq("tenant_id", tenantId)
      .maybeSingle();
    if (!opportunity) {
      opportunityId = null;
    } else if (!contactId && opportunity.contact_id) {
      contactId = opportunity.contact_id;
    }
  }

  const sent = await sendGmailMessage({
    tenantId,
    to: toRecipients,
    cc: ccRecipients,
    subject,
    bodyHtml,
    threadId: input.threadId?.trim() || null,
  });

  if (!sent.ok) {
    return { ok: false, error: sent.error };
  }

  const account = await loadGmailAccount(tenantId);
  const snippet = buildEmailSnippet(bodyHtml);
  const bodyText = htmlToPlainText(bodyHtml);
  const sentAt = new Date().toISOString();

  const db = getSupabaseAdmin();
  if (!db) {
    return { ok: false, error: "Could not save email record." };
  }

  const { data: row, error: insertError } = await db
    .from("crm_emails")
    .insert({
      tenant_id: tenantId,
      user_id: user.id,
      contact_id: contactId,
      opportunity_id: opportunityId,
      provider: "gmail",
      provider_message_id: sent.providerMessageId,
      thread_id: sent.threadId,
      direction: "outbound",
      from_email: account?.fromEmail ?? user.email ?? "",
      from_name: account?.fromName ?? null,
      to_recipients: toRecipients,
      cc_recipients: ccRecipients,
      subject,
      body_html: bodyHtml,
      body_text: bodyText,
      snippet,
      status: "sent",
      sent_at: sentAt,
    })
    .select("id")
    .single();

  let emailId = row?.id ?? null;

  if (insertError?.code === "23505" && sent.providerMessageId) {
    const { data: existing } = await db
      .from("crm_emails")
      .select("id")
      .eq("tenant_id", tenantId)
      .eq("provider", "gmail")
      .eq("provider_message_id", sent.providerMessageId)
      .maybeSingle();

    if (existing) {
      await db
        .from("crm_emails")
        .update({
          contact_id: contactId,
          opportunity_id: opportunityId,
          thread_id: sent.threadId,
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
    return { ok: false, error: "Email was sent but could not be saved in REOS." };
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

    const { data: contact } = await supabase
      .from("contacts")
      .select("record_type")
      .eq("id", contactId)
      .maybeSingle();
    const kind: PersonKind = contact?.record_type === "contact" ? "contact" : "lead";
    revalidatePath(`${personBasePath(kind)}/${contactId}`);
    revalidatePath("/contacts");
    revalidatePath("/leads");
  }

  if (opportunityId) {
    revalidatePath(`/opportunities/${opportunityId}`);
  }

  return { ok: true, emailId };
}

export async function getEmailComposeBootstrapAction(): Promise<{
  connected: boolean;
  accounts: Array<{ provider: "gmail"; email: string; label: string | null }>;
  signature: string | null;
  showAdminConnect: boolean;
}> {
  const { tenantId } = await resolveCurrentTenant();
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  let signature: string | null = null;
  if (user) {
    const { data: profile } = await supabase
      .from("profiles")
      .select("email_signature")
      .eq("id", user.id)
      .maybeSingle();
    signature = profile?.email_signature?.trim() || null;
  }

  let showAdminConnect = false;
  if (user) {
    showAdminConnect = await isPlatformAdmin(user.id);
  }

  if (!tenantId) {
    return { connected: false, accounts: [], signature, showAdminConnect };
  }

  const account = await loadGmailAccount(tenantId);
  if (!account) {
    return { connected: false, accounts: [], signature, showAdminConnect };
  }

  return {
    connected: true,
    accounts: [
      {
        provider: "gmail",
        email: account.fromEmail,
        label: account.fromName,
      },
    ],
    signature,
    showAdminConnect,
  };
}

export async function lookupContactByEmailAction(email: string): Promise<{
  id: string;
  name: string;
  email: string;
} | null> {
  const trimmed = email.trim().toLowerCase();
  if (!trimmed) return null;

  const { tenantId } = await resolveCurrentTenant();
  if (!tenantId) return null;

  const supabase = await createClient();
  const { data } = await supabase
    .from("contacts")
    .select("id, first_name, last_name, email")
    .eq("tenant_id", tenantId)
    .ilike("email", trimmed)
    .maybeSingle();

  if (!data?.email) return null;
  const name = [data.first_name, data.last_name].filter(Boolean).join(" ").trim();
  return {
    id: data.id,
    name: name || data.email,
    email: data.email.trim(),
  };
}
