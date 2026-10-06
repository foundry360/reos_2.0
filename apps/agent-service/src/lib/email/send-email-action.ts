"use server";

import { revalidatePath } from "next/cache";
import {
  htmlToPlainText,
  parseRecipientList,
  resolveReplyToEmail,
} from "@/lib/email/email-utils";
import type { SendEmailInput } from "@/lib/email/email-types";
import { personBasePath, type PersonKind } from "@/lib/crm/person-kind";
import { sendComposedEmail } from "@/lib/email/compose-email";
import {
  getResendSender,
  isResendEmailConfigured,
} from "@/lib/email/resend";
import type { ComposeSendResult } from "@/lib/messaging/compose-draft";
import { createClient } from "@/lib/supabase/server";
import { resolveCurrentTenant } from "@/lib/tenant/current-tenant";
import { isPlatformAdmin } from "@/lib/admin/auth";

export async function sendEmailAction(input: SendEmailInput): Promise<ComposeSendResult> {
  const subject = input.subject.trim();
  const bodyHtml = input.bodyHtml.trim();
  const toRecipients = parseRecipientList(input.to);
  const ccRecipients = parseRecipientList(input.cc ?? "");

  if (toRecipients.length === 0) {
    return { outcome: "not_attempted", error: "Enter at least one valid recipient." };
  }
  if (!subject) {
    return { outcome: "not_attempted", error: "Subject is required." };
  }
  if (!bodyHtml || !htmlToPlainText(bodyHtml)) {
    return { outcome: "not_attempted", error: "Email body cannot be empty." };
  }

  const { tenantId } = await resolveCurrentTenant();
  if (!tenantId) {
    return { outcome: "not_attempted", error: "Your account is not linked to a workspace yet." };
  }

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { outcome: "not_attempted", error: "You must be signed in to send email." };

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
    return { outcome: "not_attempted", error: "Your REOS account does not have an email address." };
  }
  const agentEmail = resolveReplyToEmail(
    loginEmail,
    (profileRow as { reply_to_email?: string | null } | null)?.reply_to_email,
  );
  const agentName =
    profileRow?.display_name?.trim() || loginEmail.split("@")[0] || "Agent";

  const result = await sendComposedEmail(supabase, {
    tenantId,
    userId: user.id,
    draftId: input.draftId,
    contactId,
    opportunityId,
    to: toRecipients,
    cc: ccRecipients,
    subject,
    bodyHtml,
    threadId: input.threadId ?? null,
    replyTo: agentEmail,
    agentName,
  });
  if (result.outcome === "not_attempted" || result.outcome === "draft_conflict") return result;

  if (contactId) {
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

  return result;
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
