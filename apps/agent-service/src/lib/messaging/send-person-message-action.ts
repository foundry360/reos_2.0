"use server";

import { revalidatePath } from "next/cache";
import { appendMessage } from "@/lib/db/contacts";
import { personBasePath, type PersonKind } from "@/lib/crm/person-kind";
import type { MetaChannelMetadata } from "@/lib/meta/channel-account";
import { sendMetaTextMessage } from "@/lib/meta/send";
import { sendSmsMessage } from "@/lib/messaging/send-sms";
import { createClient } from "@/lib/supabase/server";
import { resolveCurrentTenant } from "@/lib/tenant/current-tenant";

export type MessagingChannel = "sms" | "messenger" | "instagram";

export interface SendPersonMessageResult {
  ok: boolean;
  error?: string;
  messageId?: string;
}

function normalizeSmsExternalId(value: string): string {
  const digits = value.replace(/\D/g, "");
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
  if (digits.length === 10) return `+1${digits}`;
  if (value.startsWith("+")) return value;
  return digits.length > 0 ? `+${digits}` : value;
}

export async function sendPersonMessageAction(input: {
  contactId: string;
  channel: MessagingChannel;
  body: string;
}): Promise<SendPersonMessageResult> {
  const body = input.body.trim();
  if (!body) return { ok: false, error: "Message cannot be empty." };
  if (body.length > 2000) return { ok: false, error: "Message is too long." };

  const { tenantId } = await resolveCurrentTenant();
  if (!tenantId) {
    return { ok: false, error: "Your account is not linked to a workspace yet." };
  }

  const supabase = await createClient();
  const { data: contact, error: contactError } = await supabase
    .from("contacts")
    .select("id, record_type, opted_out")
    .eq("id", input.contactId)
    .eq("tenant_id", tenantId)
    .maybeSingle();

  if (contactError || !contact) {
    return { ok: false, error: "Client not found." };
  }

  if (contact.opted_out && input.channel === "sms") {
    return { ok: false, error: "This contact has opted out of SMS." };
  }

  const { data: identity } = await supabase
    .from("contact_identities")
    .select("external_id")
    .eq("contact_id", contact.id)
    .eq("channel", input.channel)
    .maybeSingle();

  if (!identity?.external_id) {
    return {
      ok: false,
      error:
        input.channel === "sms"
          ? "This record has no phone number for SMS."
          : `This record has no ${input.channel} identity.`,
    };
  }

  if (input.channel === "sms") {
    const { data: phoneRow } = await supabase
      .from("tenant_phone_numbers")
      .select("phone_e164")
      .eq("tenant_id", tenantId)
      .eq("is_primary", true)
      .maybeSingle();

    const fromE164 = phoneRow?.phone_e164?.trim();
    if (!fromE164) {
      return { ok: false, error: "No primary Twilio number is configured for this account." };
    }

    const sent = await sendSmsMessage({
      fromE164,
      toE164: normalizeSmsExternalId(identity.external_id),
      body,
    });
    if (!sent.ok) return { ok: false, error: sent.error };
  } else {
    const { data: channelAccount } = await supabase
      .from("channel_accounts")
      .select("metadata, status, external_page_id")
      .eq("tenant_id", tenantId)
      .eq("channel", input.channel)
      .eq("status", "connected")
      .maybeSingle();

    const metadata = (channelAccount?.metadata ?? {}) as MetaChannelMetadata;
    const pageToken = metadata.access_token?.trim();
    if (!pageToken || !channelAccount?.external_page_id) {
      return {
        ok: false,
        error:
          input.channel === "instagram"
            ? "Instagram is not connected for this account."
            : "Messenger is not connected for this account.",
      };
    }

    const sent = await sendMetaTextMessage({
      pageAccessToken: pageToken,
      recipientId: identity.external_id,
      text: body,
    });
    if (!sent.ok) return { ok: false, error: sent.error };
  }

  const messageId = await appendMessage({
    tenantId,
    contactId: contact.id,
    channel: input.channel,
    direction: "outbound",
    body,
  });

  const kind: PersonKind = contact.record_type === "contact" ? "contact" : "lead";
  revalidatePath(`${personBasePath(kind)}/${contact.id}`);

  return { ok: true, messageId: messageId ?? undefined };
}
