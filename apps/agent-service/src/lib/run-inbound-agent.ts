import type { ChatCompletionMessageParam } from "openai/resources/chat/completions";
import {
  resolvePlaybook,
  looksLikeInfoQuestion,
  type AgentPlaybook,
  type ContactContext,
} from "@/lib/coordinator";
import { appendToThread, getThread } from "@/lib/conversation-store";
import {
  appendMessage,
  getRecentMessages,
  updateContactFields,
} from "@/lib/db/contacts";
import { applyToolCalls } from "@/lib/apply-tools";
import { isSupabaseConfigured } from "@/lib/env";
import { runAgentTurn } from "@/lib/llm/openai";
import { getSupabaseAdmin } from "@/lib/supabase/admin";

export type AgentChannel = "sms" | "messenger" | "instagram";

export interface InboundAgentResult {
  reply: string;
  playbook: AgentPlaybook;
  contactId?: string;
  /** True when compliance blocked the agent (opt-out). */
  optedOut: boolean;
}

const OPT_OUT_KEYWORDS = new Set([
  "stop",
  "unsubscribe",
  "cancel",
  "quit",
  "end",
  "remove me",
  "don't text",
  "do not text",
  "dont text",
]);

function isOptOutMessage(body: string): boolean {
  const normalized = body.trim().toLowerCase();
  if (OPT_OUT_KEYWORDS.has(normalized)) return true;
  return (
    normalized === "stop texting" ||
    normalized === "please stop" ||
    normalized === "not interested"
  );
}

async function applyCompliance(
  ctx: ContactContext,
  body: string,
): Promise<boolean> {
  if (ctx.optedOut) return true;
  if (!isOptOutMessage(body)) return false;
  if (ctx.contactId) {
    await updateContactFields(ctx.contactId, {
      opted_out: true,
      ready_to_book: false,
    });
  }
  return true;
}

async function isPlaybookEnabled(
  tenantId: string,
  playbook: AgentPlaybook,
): Promise<boolean> {
  if (playbook === "none") return false;
  const db = getSupabaseAdmin();
  if (!db || tenantId === "default-tenant") return true;

  const { data } = await db
    .from("tenant_agents")
    .select("concierge_enabled, scheduler_enabled, follow_up_enabled")
    .eq("tenant_id", tenantId)
    .maybeSingle();

  if (!data) return true;

  if (playbook === "concierge") return data.concierge_enabled !== false;
  if (playbook === "scheduler") return data.scheduler_enabled !== false;
  if (playbook === "follow_up") return data.follow_up_enabled !== false;
  return true;
}

function buildContextBlock(ctx: ContactContext, channel: AgentChannel): string {
  return [
    `Channel: ${channel}`,
    `External id: ${ctx.phone}`,
    ctx.firstName ? `First name: ${ctx.firstName}` : null,
    ctx.lastName ? `Last name: ${ctx.lastName}` : null,
    ctx.email ? `Email: ${ctx.email}` : null,
    `Lead status: ${ctx.leadStatus}`,
    ctx.leadTemperature ? `Lead temperature: ${ctx.leadTemperature}` : null,
    ctx.intent ? `Intent: ${ctx.intent}` : null,
    ctx.targetLocation ? `Target location: ${ctx.targetLocation}` : null,
    ctx.propertyType ? `Property type: ${ctx.propertyType}` : null,
    ctx.budget ? `Budget: ${ctx.budget}` : null,
    ctx.timeline ? `Timeline: ${ctx.timeline}` : null,
    ctx.financingStatus ? `Financing: ${ctx.financingStatus}` : null,
    ctx.mustHaves ? `Must-haves: ${ctx.mustHaves}` : null,
    ctx.motivation ? `Motivation: ${ctx.motivation}` : null,
    ctx.preferences ? `Preferences: ${ctx.preferences}` : null,
    `ready_to_book: ${ctx.readyToBook}`,
    `appt_booked: ${ctx.apptBooked}`,
    `handoff: ${ctx.handoff}`,
    ctx.qualificationScore != null
      ? `Qualification score: ${ctx.qualificationScore}`
      : null,
    ctx.aiSummary ? `AI Summary: ${ctx.aiSummary}` : null,
    ctx.agentBrief ? `Agent Brief: ${ctx.agentBrief}` : null,
    // Do not pass recommended_next_action into the model context; it biases
    // replies toward "schedule a consult" instead of answering questions.
  ]
    .filter(Boolean)
    .join("\n");
}

async function loadHistory(
  tenantId: string,
  threadKey: string,
  contactId?: string,
): Promise<ChatCompletionMessageParam[]> {
  if (isSupabaseConfigured() && contactId) {
    const rows = await getRecentMessages(contactId);
    if (rows.length > 0) {
      return rows.map((m) => ({ role: m.role, content: m.content }));
    }
  }
  return getThread(tenantId, threadKey);
}

async function persistTurn(params: {
  tenantId: string;
  threadKey: string;
  contactId?: string;
  channel: AgentChannel;
  userBody: string;
  reply: string;
  playbook: AgentPlaybook;
}): Promise<void> {
  const { tenantId, threadKey, contactId, channel, userBody, reply, playbook } =
    params;

  if (isSupabaseConfigured() && contactId && tenantId !== "default-tenant") {
    await appendMessage({
      tenantId,
      contactId,
      channel,
      direction: "inbound",
      body: userBody,
    });
    if (reply) {
      await appendMessage({
        tenantId,
        contactId,
        channel,
        direction: "outbound",
        body: reply,
        playbook,
      });
    }
    return;
  }

  appendToThread(tenantId, threadKey, { role: "user", content: userBody });
  if (reply) {
    appendToThread(tenantId, threadKey, { role: "assistant", content: reply });
  }
}

/**
 * Shared conversational agent loop for SMS + Meta.
 * Caller resolves ContactContext; this handles compliance → route → LLM → CRM tools → persist.
 */
export async function runInboundAgent(params: {
  ctx: ContactContext;
  body: string;
  channel: AgentChannel;
}): Promise<InboundAgentResult> {
  const { ctx, body, channel } = params;
  const tenantId = ctx.accountId ?? "default-tenant";
  const threadKey = ctx.phone;

  if (await applyCompliance(ctx, body)) {
    const reply = ctx.optedOut ? "" : "You have been unsubscribed.";
    await persistTurn({
      tenantId,
      threadKey,
      contactId: ctx.contactId,
      channel,
      userBody: body,
      reply,
      playbook: "none",
    });
    return {
      reply,
      playbook: "none",
      contactId: ctx.contactId,
      optedOut: true,
    };
  }

  let playbook = resolvePlaybook(ctx, body);
  if (playbook !== "none" && !(await isPlaybookEnabled(tenantId, playbook))) {
    playbook = "none";
  }

  // If they asked a question while stuck in ready_to_book, clear it so the next
  // turns stay conversational until they actually want to schedule.
  if (
    playbook === "concierge" &&
    ctx.readyToBook &&
    looksLikeInfoQuestion(body) &&
    ctx.contactId
  ) {
    await updateContactFields(ctx.contactId, { ready_to_book: false });
    ctx.readyToBook = false;
  }

  if (playbook === "none") {
    await persistTurn({
      tenantId,
      threadKey,
      contactId: ctx.contactId,
      channel,
      userBody: body,
      reply: "",
      playbook: "none",
    });
    return {
      reply: "",
      playbook: "none",
      contactId: ctx.contactId,
      optedOut: false,
    };
  }

  const history = await loadHistory(tenantId, threadKey, ctx.contactId);
  const { reply, toolCalls } = await runAgentTurn(
    playbook,
    history,
    body,
    buildContextBlock(ctx, channel),
  );

  // Never escalate to booking/handoff just because they asked a question.
  if (looksLikeInfoQuestion(body)) {
    for (const tc of toolCalls) {
      if (tc.name !== "update_contact") continue;
      if (tc.args.ready_to_book === true) tc.args.ready_to_book = false;
      if (tc.args.handoff === true) delete tc.args.handoff;
    }
  }

  await persistTurn({
    tenantId,
    threadKey,
    contactId: ctx.contactId,
    channel,
    userBody: body,
    reply,
    playbook,
  });
  await applyToolCalls(ctx.contactId, toolCalls);

  return {
    reply,
    playbook,
    contactId: ctx.contactId,
    optedOut: false,
  };
}
