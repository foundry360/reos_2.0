/**
 * Journey "Send Messenger" / "Send Instagram": a DM to the lead through the
 * shared delivery layer, which needs the lead's Messenger or Instagram DM
 * identity. Comment identities are a different channel and never used here.
 *
 * Pure module (relative imports only) so it runs under node --test.
 */

import type { DeliverMessageResult, MessageSuppression } from "../../messaging/deliver-message.ts";
import { renderTemplate, type ActionConfig } from "./contracts.ts";
import { JourneyStepError, type ActionInput, type ActionResult } from "./engine.ts";

export type DirectMessageChannel = "messenger" | "instagram";

export type DeliverDirectMessage = (input: {
  tenantId: string;
  contactId: string;
  channel: DirectMessageChannel;
  body: string;
  automated: true;
  idempotencyKey: string;
}) => Promise<DeliverMessageResult>;

/**
 * The idempotency key of a journey step's send. A run never reaches the same
 * node twice, so it names one logical message: every retry of the step reuses it.
 */
export function journeySendKey(input: Pick<ActionInput, "runId" | "nodeId">): string {
  return `journey:${input.runId}:${input.nodeId}`;
}

/**
 * A customer-facing send the contact's current state forbids (opt-out, handoff,
 * email unsubscribe, or a closed Meta messaging window): nothing was sent and
 * the step is skipped, not failed, so the run goes on to its next step.
 * `sent: false` and no message id, so a condition on the step's output never
 * reads it as delivered.
 */
export function suppressedSend(channel: "sms" | "email" | DirectMessageChannel, reason: MessageSuppression): ActionResult {
  return { status: "skipped", output: { sent: false, channel }, reason };
}

/**
 * The step result for a delivery. A rejected send may be retried (transient); a
 * send whose outcome is unknown fails without retry, since a retry could send
 * the message twice. A repeat of an already-sent step returns the same message.
 */
export function deliveryResult(
  channel: "sms" | DirectMessageChannel,
  body: string,
  sent: DeliverMessageResult,
): ActionResult {
  if (!sent.ok && sent.suppressed) return suppressedSend(channel, sent.suppressed);
  if (!sent.ok) throw new JourneyStepError(sent.error, sent.kind === "ambiguous" ? "config" : sent.kind);
  return {
    status: "completed",
    output: {
      sent: true,
      message_id: sent.messageId,
      provider_message_id: sent.providerMessageId ?? null,
      channel,
      body,
    },
  };
}

export async function executeSendMessage(
  channel: DirectMessageChannel,
  action: Extract<ActionConfig, { action: "send_messenger" | "send_instagram" }>,
  input: ActionInput,
  deliver: DeliverDirectMessage,
): Promise<ActionResult> {
  if (!input.contactId || !input.lead) {
    throw new JourneyStepError("This run isn't linked to a lead in this workspace.", "config");
  }
  const names = {
    first_name: typeof input.lead.first_name === "string" ? input.lead.first_name : null,
    last_name: typeof input.lead.last_name === "string" ? input.lead.last_name : null,
  };
  const body = renderTemplate(action.body, names).trim();
  const sent = await deliver({
    tenantId: input.tenantId,
    contactId: input.contactId,
    channel,
    body,
    automated: true,
    idempotencyKey: journeySendKey(input),
  });
  return deliveryResult(channel, body, sent);
}
