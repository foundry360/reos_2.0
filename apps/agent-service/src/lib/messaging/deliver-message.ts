import type { SupabaseClient } from "@supabase/supabase-js";
import type { MetaChannelMetadata } from "@/lib/meta/channel-account";
import { sendMetaTextMessage } from "@/lib/meta/send";
import { beginOutboundMessage, recordOutboundOutcome } from "@/lib/messaging/outbound-messages";
import { failureForThrown, outcomeOf, type ProviderFailure } from "@/lib/messaging/provider-outcome";
import { sendSmsMessage } from "@/lib/messaging/send-sms";

export type MessagingChannel = "sms" | "messenger" | "instagram";

/**
 * Why a message to the contact must not be sent right now: the contact opted out,
 * a human took over (handoff), automated email was unsubscribed, or Meta's
 * standard 24-hour messaging window has closed.
 */
export type MessageSuppression = "opted_out" | "handoff" | "unsubscribed" | "outside_messaging_window";

export type DeliverMessageResult =
  | {
      ok: true;
      messageId: string | null;
      recordType: string | null;
      providerMessageId?: string | null;
      /** An earlier attempt with the same idempotency key was already sent; nothing was sent now. */
      deduplicated?: boolean;
    }
  /**
   * "config": the record or workspace can't receive this message; "transient": nothing was
   * sent (the provider rejected it, or it couldn't be recorded first) and it may be retried;
   * "ambiguous": the provider may have sent it, so it must not be sent again automatically.
   * `suppressed` is set when the contact's current state forbids the message; nothing was sent.
   */
  | { ok: false; error: string; kind: "config" | "transient" | "ambiguous"; suppressed?: MessageSuppression };

/** Meta's standard messaging window: a Page may message a person within 24 hours of their last message. */
export const META_MESSAGING_WINDOW_MS = 24 * 60 * 60_000;

export const AMBIGUOUS_SEND_ERROR =
  "An earlier attempt at this message may have been sent (the provider didn't confirm it), so it wasn't sent again. Check the conversation.";

export function normalizeSmsExternalId(value: string): string {
  const digits = value.replace(/\D/g, "");
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
  if (digits.length === 10) return `+1${digits}`;
  if (value.startsWith("+")) return value;
  return digits.length > 0 ? `+${digits}` : value;
}

/**
 * Sends a message to a contact on SMS/Messenger/Instagram and records it in the
 * conversation. `db` decides the trust boundary: the signed-in user's client
 * for manual sends, the service role for server-side automation.
 *
 * The contact is read here, just before the provider call, so every check uses
 * its current state. Channel and consent rules apply to every send, manual or
 * automated: nothing goes to an opted-out contact (SMS STOP; Meta also requires
 * honoring opt-out requests made on any channel), and Messenger/Instagram only
 * within Meta's 24-hour window. Only automation rules yield to a person:
 * `automated` (journey sends) also refuses while the contact is handed off.
 *
 * The message row is written as pending before the provider call and then gets
 * the provider's answer (sent, failed, or unknown). `idempotencyKey` names the
 * logical send: a repeat returns the earlier sent row instead of sending again,
 * and refuses to send when the earlier outcome is unknown.
 */
export async function deliverMessageToContact(
  db: SupabaseClient,
  input: {
    tenantId: string;
    contactId: string;
    channel: MessagingChannel;
    body: string;
    automated?: boolean;
    idempotencyKey?: string;
  },
): Promise<DeliverMessageResult> {
  const { tenantId, channel, body } = input;

  const { data: contact, error: contactError } = await db
    .from("contacts")
    .select(input.automated ? "id, record_type, opted_out, handoff" : "id, record_type, opted_out")
    .eq("id", input.contactId)
    .eq("tenant_id", tenantId)
    .maybeSingle<{ id: string; record_type: string | null; opted_out: boolean | null; handoff?: boolean | null }>();

  if (contactError || !contact) {
    return { ok: false, error: "Client not found.", kind: "config" };
  }

  if (contact.opted_out) {
    return {
      ok: false,
      error: channel === "sms" ? "This contact has opted out of SMS." : "This contact has opted out of messages.",
      kind: "config",
      suppressed: "opted_out",
    };
  }

  if (input.automated && contact.handoff) {
    return { ok: false, error: "This contact is handed off to the team.", kind: "config", suppressed: "handoff" };
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

  let send: () => Promise<{ ok: true; providerMessageId: string | null } | ProviderFailure>;
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
    const toE164 = normalizeSmsExternalId(identity.external_id);
    send = async () => {
      const sent = await sendSmsMessage({ fromE164, toE164, body });
      return sent.ok ? { ok: true, providerMessageId: sent.id } : sent;
    };
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
    const { data: lastInbound, error: windowError } = await db
      .from("messages")
      .select("created_at")
      .eq("tenant_id", tenantId)
      .eq("contact_id", contact.id)
      .eq("channel", channel)
      .eq("direction", "inbound")
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle<{ created_at: string }>();
    if (windowError) {
      return { ok: false, error: "Couldn't check the messaging window, so nothing was sent.", kind: "transient" };
    }
    const lastAt = lastInbound ? new Date(lastInbound.created_at).getTime() : Number.NaN;
    if (!(Date.now() - lastAt < META_MESSAGING_WINDOW_MS)) {
      return {
        ok: false,
        error: `Meta only allows messages within 24 hours of the contact's last ${channel === "instagram" ? "Instagram" : "Messenger"} message.`,
        kind: "config",
        suppressed: "outside_messaging_window",
      };
    }
    const recipientId = identity.external_id;
    send = async () => {
      const sent = await sendMetaTextMessage({ pageAccessToken: pageToken, recipientId, text: body });
      return sent.ok ? { ok: true, providerMessageId: sent.messageId } : sent;
    };
  }

  const recordType = contact.record_type ?? null;
  const attempt = await beginOutboundMessage({
    tenantId,
    contactId: contact.id,
    channel,
    body,
    idempotencyKey: input.idempotencyKey,
  });
  if (attempt.status === "error") return { ok: false, error: attempt.error, kind: "transient" };
  if (attempt.status === "already_sent") {
    return { ok: true, messageId: attempt.messageId, recordType, providerMessageId: attempt.providerMessageId, deduplicated: true };
  }
  if (attempt.status === "unresolved") return { ok: false, error: AMBIGUOUS_SEND_ERROR, kind: "ambiguous" };

  let result: Awaited<ReturnType<typeof send>>;
  try {
    result = await send();
  } catch (error) {
    result = failureForThrown(error);
  }

  // If this fails the row stays pending: unconfirmed, never retried as unsent, and never shown as sent.
  await recordOutboundOutcome({ tenantId, messageId: attempt.messageId, outcome: outcomeOf(result) }).catch((error) => {
    console.error("Outbound message outcome error:", error instanceof Error ? error.message : error);
  });

  if (result.ok) {
    return { ok: true, messageId: attempt.messageId, recordType, providerMessageId: result.providerMessageId };
  }
  return { ok: false, error: result.error, kind: result.outcome === "rejected" ? "transient" : "ambiguous" };
}
