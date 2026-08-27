import type { ChatCompletionMessageParam } from "openai/resources/chat/completions";
import { resolvePlaybook, type ContactContext } from "@/lib/coordinator";
import { appendToThread, getThread } from "@/lib/conversation-store";
import { runAgentTurn } from "@/lib/llm/openai";
import {
  appendMessage,
  getRecentMessages,
  resolveInboundContact,
  updateContactFields,
} from "@/lib/db/contacts";
import { applyToolCalls } from "@/lib/apply-tools";
import { isSupabaseConfigured } from "@/lib/env";

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

const OPT_OUT_KEYWORDS = new Set(["stop", "unsubscribe", "cancel", "quit", "end"]);

function isOptOutMessage(body: string): boolean {
  const normalized = body.trim().toLowerCase();
  return OPT_OUT_KEYWORDS.has(normalized);
}

async function applyCompliance(ctx: ContactContext, body: string): Promise<boolean> {
  if (ctx.optedOut || ctx.leadStatus === "Compliance") return true;
  if (!isOptOutMessage(body)) return false;
  if (ctx.contactId) {
    await updateContactFields(ctx.contactId, {
      opted_out: true,
      lead_status: "Compliance",
    });
  }
  return true;
}

async function loadHistory(
  tenantId: string,
  phone: string,
  contactId?: string,
): Promise<ChatCompletionMessageParam[]> {
  if (isSupabaseConfigured() && contactId) {
    const rows = await getRecentMessages(contactId);
    if (rows.length > 0) {
      return rows.map((m) => ({ role: m.role, content: m.content }));
    }
  }
  return getThread(tenantId, phone);
}

async function persistTurn(
  tenantId: string,
  phone: string,
  contactId: string | undefined,
  userBody: string,
  reply: string,
  playbook: string,
): Promise<void> {
  if (isSupabaseConfigured() && contactId && tenantId !== "default-tenant") {
    await appendMessage({
      tenantId,
      contactId,
      channel: "sms",
      direction: "inbound",
      body: userBody,
    });
    await appendMessage({
      tenantId,
      contactId,
      channel: "sms",
      direction: "outbound",
      body: reply,
      playbook,
    });
    return;
  }

  appendToThread(tenantId, phone, { role: "user", content: userBody });
  appendToThread(tenantId, phone, { role: "assistant", content: reply });
}

export async function handleInboundSms(sms: InboundSms): Promise<OutboundSms> {
  const ctx: ContactContext = await resolveInboundContact({
    channel: "sms",
    from: sms.from,
    to: sms.to,
  });
  const tenantId = ctx.accountId ?? "default-tenant";

  if (await applyCompliance(ctx, sms.body)) {
    return {
      reply: ctx.optedOut || ctx.leadStatus === "Compliance" ? "" : "You have been unsubscribed.",
      playbook: "none",
      contactId: ctx.contactId,
    };
  }

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

  const history = await loadHistory(tenantId, sms.from, ctx.contactId);
  const { reply, toolCalls } = await runAgentTurn(
    playbook,
    history,
    sms.body,
    contextBlock,
  );

  await persistTurn(tenantId, sms.from, ctx.contactId, sms.body, reply, playbook);
  await applyToolCalls(ctx.contactId, toolCalls);

  return { reply, playbook, contactId: ctx.contactId };
}
