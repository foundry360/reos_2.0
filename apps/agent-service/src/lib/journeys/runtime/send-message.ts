/**
 * Journey "Send Messenger" / "Send Instagram": a DM to the lead through the
 * shared delivery layer, which needs the lead's Messenger or Instagram DM
 * identity. Comment identities are a different channel and never used here.
 *
 * Pure module (relative imports only) so it runs under node --test.
 */

import type { DeliverMessageResult } from "../../messaging/deliver-message.ts";
import { renderTemplate, type ActionConfig } from "./contracts.ts";
import { JourneyStepError, type ActionInput, type ActionResult } from "./engine.ts";

export type DirectMessageChannel = "messenger" | "instagram";

export type DeliverDirectMessage = (input: {
  tenantId: string;
  contactId: string;
  channel: DirectMessageChannel;
  body: string;
}) => Promise<DeliverMessageResult>;

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
  const sent = await deliver({ tenantId: input.tenantId, contactId: input.contactId, channel, body });
  if (!sent.ok) throw new JourneyStepError(sent.error, sent.kind);
  return { status: "completed", output: { message_id: sent.messageId, channel, body } };
}
