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
}) => Promise<DeliverMessageResult>;

/**
 * A customer-facing send the contact's current state forbids (SMS opt-out, or
 * handoff to a human): nothing was sent and the step is skipped, not failed, so
 * the run goes on to its next step. `sent: false` and no message id, so a
 * condition on the step's output never reads it as delivered.
 */
export function suppressedSend(channel: "sms" | "email" | DirectMessageChannel, reason: MessageSuppression): ActionResult {
  return { status: "skipped", output: { sent: false, channel }, reason };
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
  const sent = await deliver({ tenantId: input.tenantId, contactId: input.contactId, channel, body, automated: true });
  if (!sent.ok && sent.suppressed) return suppressedSend(channel, sent.suppressed);
  if (!sent.ok) throw new JourneyStepError(sent.error, sent.kind);
  return { status: "completed", output: { message_id: sent.messageId, channel, body } };
}
