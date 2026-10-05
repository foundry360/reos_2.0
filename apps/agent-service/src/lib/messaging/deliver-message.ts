import type { SupabaseClient } from "@supabase/supabase-js";
import { appendMessage } from "@/lib/db/contacts";
import type { MetaChannelMetadata } from "@/lib/meta/channel-account";
import { sendMetaTextMessage } from "@/lib/meta/send";
import { sendSmsMessage } from "@/lib/messaging/send-sms";

export type MessagingChannel = "sms" | "messenger" | "instagram";

export type DeliverMessageResult =
  | { ok: true; messageId: string | null; recordType: string | null }
  /** "config": the record or workspace can't receive this message; "transient": the provider failed. */
  | { ok: false; error: string; kind: "config" | "transient" };

export function normalizeSmsExternalId(value: string): string {
  const digits = value.replace(/\D/g, "");
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
  if (digits.length === 10) return `+1${digits}`;
  if (value.startsWith("+")) return value;
  return digits.length > 0 ? `+${digits}` : value;
}

/**
 * Sends a message to a contact on SMS/Messenger/Instagram and logs it to the
 * conversation. `db` decides the trust boundary: the signed-in user's client
 * for manual sends, the service role for server-side automation.
 */
export async function deliverMessageToContact(
  db: SupabaseClient,
  input: { tenantId: string; contactId: string; channel: MessagingChannel; body: string },
): Promise<DeliverMessageResult> {
  const { tenantId, channel, body } = input;

  const { data: contact, error: contactError } = await db
    .from("contacts")
    .select("id, record_type, opted_out")
    .eq("id", input.contactId)
    .eq("tenant_id", tenantId)
    .maybeSingle();

  if (contactError || !contact) {
    return { ok: false, error: "Client not found.", kind: "config" };
  }

  if (contact.opted_out && channel === "sms") {
    return { ok: false, error: "This contact has opted out of SMS.", kind: "config" };
  }

  const { data: identity } = await db
    .from("contact_identities")
    .select("external_id")
    .eq("contact_id", contact.id)
    .eq("channel", channel)
    .maybeSingle();

  if (!identity?.external_id) {
    return {
      ok: false,
      kind: "config",
      error:
        channel === "sms"
          ? "This record has no phone number for SMS."
          : `This record has no ${channel} identity.`,
    };
  }

  if (channel === "sms") {
    const { data: phoneRow } = await db
      .from("tenant_phone_numbers")
      .select("phone_e164")
      .eq("tenant_id", tenantId)
      .eq("is_primary", true)
      .maybeSingle();

    const fromE164 = phoneRow?.phone_e164?.trim();
    if (!fromE164) {
      return { ok: false, error: "No primary SMS number is configured for this account.", kind: "config" };
    }

    const sent = await sendSmsMessage({
      fromE164,
      toE164: normalizeSmsExternalId(identity.external_id),
      body,
    });
    if (!sent.ok) return { ok: false, error: sent.error, kind: "transient" };
  } else {
    const { data: channelAccount } = await db
      .from("channel_accounts")
      .select("metadata, status, external_page_id")
      .eq("tenant_id", tenantId)
      .eq("channel", channel)
      .eq("status", "connected")
      .maybeSingle();

    const metadata = (channelAccount?.metadata ?? {}) as MetaChannelMetadata;
    const pageToken = metadata.access_token?.trim();
    if (!pageToken || !channelAccount?.external_page_id) {
      return {
        ok: false,
        kind: "config",
        error:
          channel === "instagram"
            ? "Instagram is not connected for this account."
            : "Messenger is not connected for this account.",
      };
    }

    const sent = await sendMetaTextMessage({
      pageAccessToken: pageToken,
      recipientId: identity.external_id,
      text: body,
    });
    if (!sent.ok) return { ok: false, error: sent.error, kind: "transient" };
  }

  // The provider accepted the message, so this is a successful send even if logging it
  // fails (messageId null, as appendMessage already returns for database errors).
  // Reporting it as failed would get it sent again.
  let messageId: string | null = null;
  try {
    messageId = await appendMessage({
      tenantId,
      contactId: contact.id,
      channel,
      direction: "outbound",
      body,
    });
  } catch (error) {
    console.error("Append message error:", error instanceof Error ? error.message : error);
  }

  return { ok: true, messageId, recordType: contact.record_type ?? null };
}
