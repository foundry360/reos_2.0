import type { ContactContext } from "@/lib/coordinator";
import { resolveInboundContact } from "@/lib/db/contacts";
import { runProviderInboundTurn, type InboundTurnDeps } from "@/lib/inbound-turn";
import { recordReplyOutcome } from "@/lib/messaging/outbound-messages";
import { failureForThrown, outcomeOf, type OutboundOutcome } from "@/lib/messaging/provider-outcome";
import { sendSmsMessage } from "@/lib/messaging/send-sms";

export interface InboundSms {
  from: string;
  body: string;
  to?: string;
  /** Telnyx message id; redeliveries of the same message carry the same id. */
  providerMessageId?: string | null;
}

export interface OutboundSms {
  reply: string;
  playbook: string;
  contactId?: string;
  /** This Telnyx message was already received; nothing was done and nothing should be sent. */
  duplicate?: boolean;
  tenantId?: string;
  /** The stored reply (pending until sendAgentSmsReply records the provider's answer). */
  replyMessageId?: string | null;
}

export interface AgentSmsReplyDeps {
  sendSms: typeof sendSmsMessage;
  recordOutcome: typeof recordReplyOutcome;
}

const liveReplyDeps: AgentSmsReplyDeps = { sendSms: sendSmsMessage, recordOutcome: recordReplyOutcome };

/**
 * Sends the agent's SMS reply from the number the lead texted, then records the
 * provider's answer on the stored reply: sent, failed, or unknown. A reply that
 * isn't sent stays in the conversation, marked as not sent.
 */
export async function sendAgentSmsReply(
  reply: OutboundSms,
  sms: { from: string; to?: string },
  deps: AgentSmsReplyDeps = liveReplyDeps,
): Promise<OutboundOutcome | null> {
  if (reply.duplicate || !reply.reply) return null;
  let outcome: OutboundOutcome;
  if (!sms.to) {
    outcome = { status: "failed", error: "The inbound message had no number to reply from." };
  } else {
    let sent: Awaited<ReturnType<typeof sendSmsMessage>>;
    try {
      sent = await deps.sendSms({ fromE164: sms.to, toE164: sms.from, body: reply.reply });
    } catch (error) {
      sent = failureForThrown(error);
    }
    outcome = outcomeOf(sent.ok ? { ok: true, providerMessageId: sent.id } : sent);
  }
  if (outcome.status !== "sent") console.error("Telnyx reply send failed:", outcome.status, outcome.error);
  await deps.recordOutcome(reply.tenantId, reply.replyMessageId, outcome);
  return outcome;
}

export interface InboundSmsDeps {
  resolveContact: typeof resolveInboundContact;
  turn?: InboundTurnDeps;
}

export async function handleInboundSms(
  sms: InboundSms,
  deps: InboundSmsDeps = { resolveContact: resolveInboundContact },
): Promise<OutboundSms> {
  const ctx: ContactContext = await deps.resolveContact({
    channel: "sms",
    from: sms.from,
    to: sms.to,
  });

  const turn = await runProviderInboundTurn(
    { ctx, body: sms.body, channel: "sms", providerMessageId: sms.providerMessageId ?? null },
    deps.turn,
  );
  if (turn.status === "duplicate") {
    return { reply: "", playbook: "none", contactId: ctx.contactId, duplicate: true };
  }

  return {
    reply: turn.result.reply,
    playbook: turn.result.playbook,
    contactId: turn.result.contactId,
    tenantId: ctx.accountId,
    replyMessageId: turn.result.replyMessageId ?? null,
  };
}

interface TelnyxMessageEvent {
  data?: {
    id?: string;
    event_type?: string;
    payload?: {
      id?: string;
      direction?: string;
      text?: string;
      from?: { phone_number?: string };
      to?: Array<{ phone_number?: string }>;
    };
  };
}

/**
 * The inbound SMS in a Telnyx message.received webhook, or null for any other
 * event. The provider id is the Telnyx message id (data.payload.id), falling
 * back to the webhook event id (data.id); Telnyx redelivers both unchanged.
 */
export function parseTelnyxInboundSms(event: unknown): Required<InboundSms> | null {
  const data = (event as TelnyxMessageEvent | null)?.data;
  const payload = data?.payload;
  if (data?.event_type !== "message.received" || payload?.direction !== "inbound") return null;
  const providerMessageId = payload.id?.trim() || data.id?.trim() || null;
  return {
    from: payload.from?.phone_number ?? "",
    to: payload.to?.[0]?.phone_number ?? "",
    body: payload.text ?? "",
    providerMessageId,
  };
}
