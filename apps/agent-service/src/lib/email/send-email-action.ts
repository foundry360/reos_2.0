"use server";

import { revalidatePath } from "next/cache";
import {
  buildEmailSnippet,
  htmlToPlainText,
  parseRecipientList,
  resolveReplyToEmail,
} from "@/lib/email/email-utils";
import type { SendEmailInput, SendEmailResult } from "@/lib/email/email-types";
import { logSystemContactActivity } from "@/lib/crm/log-system-activity";
import { personBasePath, type PersonKind } from "@/lib/crm/person-kind";
import {
  getResendSender,
  isResendEmailConfigured,
  sendResendMessage,
} from "@/lib/email/resend";
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

  const { data: profile, error: profileError } = await supabase
    .from("profiles")
    .select("display_name, reply_to_email")
    .eq("id", user.id)
    .maybeSingle();
  const profileRow =
    profileError && /reply_to_email/i.test(profileError.message)
      ? (
          await supabase
            .from("profiles")
            .select("display_name")
            .eq("id", user.id)
            .maybeSingle()
        ).data
      : profile;
  const loginEmail = user.email?.trim().toLowerCase() ?? "";
  if (!loginEmail) {
    return { ok: false, error: "Your REOS account does not have an email address." };
  }
  const agentEmail = resolveReplyToEmail(
    loginEmail,
    (profileRow as { reply_to_email?: string | null } | null)?.reply_to_email,
  );
  const agentName =
    profileRow?.display_name?.trim() || loginEmail.split("@")[0] || "Agent";

  const sent = await sendResendMessage({
    to: toRecipients,
    cc: ccRecipients,
    subject,
    bodyHtml,
    replyTo: agentEmail,
    agentName,
  });

  if (!sent.ok) {
    return { ok: false, error: sent.error };
  }

  const snippet = buildEmailSnippet(bodyHtml);
  const bodyText = htmlToPlainText(bodyHtml);
  const sentAt = new Date().toISOString();
  const threadId =
    input.threadId?.trim() || `resend:${sent.providerMessageId}`;

  const db = getSupabaseAdmin();
  if (!db) {
    return { ok: false, error: "Could not save email record." };
  }

  const emailRow = {
    tenant_id: tenantId,
    user_id: user.id,
    contact_id: contactId,
    opportunity_id: opportunityId,
    provider_message_id: sent.providerMessageId,
    thread_id: threadId,
    direction: "outbound" as const,
    from_email: sent.fromEmail,
    from_name: sent.fromName,
    to_recipients: toRecipients,
    cc_recipients: ccRecipients,
    subject,
    body_html: bodyHtml,
    body_text: bodyText,
    snippet,
    status: "sent" as const,
    sent_at: sentAt,
  };

  // Prefer provider=resend (migration 043). Until that check constraint is
  // updated, fall back to a compatible provider value and tag metadata.
  let storedProvider: "resend" | "gmail" = "resend";
  let { data: row, error: insertError } = await db
    .from("crm_emails")
    .insert({
      ...emailRow,
      provider: "resend",
      metadata: { reply_to: agentEmail },
    })
    .select("id")
    .single();

  if (
    insertError &&
    /crm_emails_provider_check/i.test(insertError.message ?? "")
  ) {
    console.warn(
      "crm_emails provider check rejected resend; saving with compatibility fallback until migration 043 is applied",
    );
    storedProvider = "gmail";
    ({ data: row, error: insertError } = await db
      .from("crm_emails")
      .insert({
        ...emailRow,
        provider: "gmail",
        metadata: {
          reply_to: agentEmail,
          delivery_provider: "resend",
        },
      })
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
  accounts: Array<{ provider: "resend"; email: string; label: string | null }>;
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

  const configured = await isResendEmailConfigured();
  const sender = getResendSender();
  if (!configured || !sender || !user?.email) {
    return { connected: false, accounts: [], signature, showAdminConnect };
  }

  const { data: profile, error: profileError } = await supabase
    .from("profiles")
    .select("display_name, reply_to_email")
    .eq("id", user.id)
    .maybeSingle();
  const profileRow =
    profileError && /reply_to_email/i.test(profileError.message)
      ? (
          await supabase
            .from("profiles")
            .select("display_name")
            .eq("id", user.id)
            .maybeSingle()
        ).data
      : profile;
  const loginEmail = user.email.trim().toLowerCase();
  const replyToEmail = resolveReplyToEmail(
    loginEmail,
    (profileRow as { reply_to_email?: string | null } | null)?.reply_to_email,
  );
  const agentName =
    profileRow?.display_name?.trim() || loginEmail.split("@")[0] || "Agent";

  return {
    connected: true,
    accounts: [
      {
        provider: "resend",
        email: replyToEmail,
        label: agentName,
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
