import { resolvePlaybook, type ContactContext } from "@/lib/coordinator";
import { appendToThread, getThread } from "@/lib/conversation-store";
import { runAgentTurn } from "@/lib/llm/openai";
import { findContactByPhone } from "@/lib/sf/client";
import { applyToolCalls } from "@/lib/apply-tools";

export interface InboundSms {
  from: string;
  body: string;
  to?: string;
}

export interface OutboundSms {
  reply: string;
  playbook: string;
  contactId?: string;
}

export async function handleInboundSms(sms: InboundSms): Promise<OutboundSms> {
  const ctx: ContactContext = await findContactByPhone(sms.from);
  const tenantId = ctx.accountId ?? "default-tenant";
  const playbook = resolvePlaybook(ctx);

  if (playbook === "none") {
    return {
      reply: "",
      playbook: "none",
      contactId: ctx.contactId,
    };
  }

  const contextBlock = [
    `Phone: ${ctx.phone}`,
    ctx.firstName ? `First name: ${ctx.firstName}` : null,
    `Lead status: ${ctx.leadStatus}`,
    ctx.aiSummary ? `AI Summary: ${ctx.aiSummary}` : null,
  ]
    .filter(Boolean)
    .join("\n");

  const history = getThread(tenantId, sms.from);
  const { reply, toolCalls } = await runAgentTurn(
    playbook,
    history,
    sms.body,
    contextBlock,
  );

  appendToThread(tenantId, sms.from, { role: "user", content: sms.body });
  appendToThread(tenantId, sms.from, { role: "assistant", content: reply });

  await applyToolCalls(ctx.contactId, toolCalls);

  return { reply, playbook, contactId: ctx.contactId };
}
