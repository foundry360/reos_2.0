import type { ContactContext } from "@/lib/coordinator";
import { claimInboundMessage } from "@/lib/db/contacts";
import { dispatchJourneyEventsSoon } from "@/lib/journeys/journey-event-dispatch";
import type { AgentChannel, InboundAgentResult, runInboundAgent } from "@/lib/run-inbound-agent";

export interface InboundTurnDeps {
  claim: typeof claimInboundMessage;
  runAgent: typeof runInboundAgent;
  dispatchSoon: typeof dispatchJourneyEventsSoon;
}

const liveDeps: InboundTurnDeps = {
  claim: claimInboundMessage,
  runAgent: async (params) => (await import("@/lib/run-inbound-agent")).runInboundAgent(params),
  dispatchSoon: dispatchJourneyEventsSoon,
};

export type InboundTurn =
  | { status: "duplicate" }
  | { status: "handled"; result: InboundAgentResult };

/**
 * One inbound provider message (Telnyx SMS, Meta DM) → at most one AI turn.
 *
 * With a provider message id and a stored contact, the message is stored first
 * under that id. That insert is the claim: a redelivery (immediate, after the
 * first finished, or while it is still running) is "duplicate" and runs no AI
 * turn, sends no reply, and records no second message.received. The claim
 * records message.received in the same transaction, so the event is durable
 * even if the AI turn below fails.
 *
 * Without a provider id or a stored contact there is nothing to dedupe on; the
 * agent stores the message itself, as before.
 */
export async function runProviderInboundTurn(
  params: {
    ctx: ContactContext;
    body: string;
    channel: AgentChannel;
    providerMessageId: string | null;
  },
  deps: InboundTurnDeps = liveDeps,
): Promise<InboundTurn> {
  const { ctx, body, channel } = params;
  const tenantId = ctx.accountId;
  let inboundPersisted = false;

  if (params.providerMessageId && ctx.contactId && tenantId && tenantId !== "default-tenant") {
    const claim = await deps.claim({
      tenantId,
      contactId: ctx.contactId,
      channel,
      body,
      providerMessageId: params.providerMessageId,
    });
    if (claim.status === "duplicate") return { status: "duplicate" };
    if (claim.status === "claimed") {
      inboundPersisted = true;
      deps.dispatchSoon(tenantId, ctx.contactId);
    }
  }

  const result = await deps.runAgent({ ctx, body, channel, inboundPersisted });
  return { status: "handled", result };
}
