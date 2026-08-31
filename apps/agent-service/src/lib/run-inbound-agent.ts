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
  ]
    .filter(Boolean)
    .join("\n");
}

/** Merge consecutive same-role turns so OpenAI accepts the thread. */
export function sanitizeChatHistory(
  rows: Array<{ role: "user" | "assistant"; content: string }>,
): ChatCompletionMessageParam[] {
  const out: ChatCompletionMessageParam[] = [];
  for (const row of rows) {
    const content = row.content?.trim();
    if (!content) continue;
    const last = out[out.length - 1];
    if (last && last.role === row.role && typeof last.content === "string") {
      last.content = `${last.content}\n${content}`;
      continue;
    }
    out.push({ role: row.role, content });
  }
  // Drop a leading assistant message (API wants user/system first after system).
  while (out.length > 0 && out[0].role === "assistant") {
    out.shift();
  }
  return out;
}

async function loadHistory(
  tenantId: string,
  threadKey: string,
  contactId?: string,
): Promise<ChatCompletionMessageParam[]> {
  if (isSupabaseConfigured() && contactId) {
    const rows = await getRecentMessages(contactId);
    if (rows.length > 0) {
      return sanitizeChatHistory(rows);
    }
  }
  return sanitizeChatHistory(
    getThread(tenantId, threadKey).map((m) => ({
      role: m.role === "assistant" ? ("assistant" as const) : ("user" as const),
      content: typeof m.content === "string" ? m.content : "",
    })),
  );
}

async function persistInbound(params: {
  tenantId: string;
  threadKey: string;
  contactId?: string;
  channel: AgentChannel;
  userBody: string;
}): Promise<void> {
  const { tenantId, threadKey, contactId, channel, userBody } = params;
  if (isSupabaseConfigured() && contactId && tenantId !== "default-tenant") {
    await appendMessage({
      tenantId,
      contactId,
      channel,
      direction: "inbound",
      body: userBody,
    });
    return;
  }
  appendToThread(tenantId, threadKey, { role: "user", content: userBody });
}

async function persistOutbound(params: {
  tenantId: string;
  threadKey: string;
  contactId?: string;
  channel: AgentChannel;
  reply: string;
  playbook: AgentPlaybook;
}): Promise<void> {
  const { tenantId, threadKey, contactId, channel, reply, playbook } = params;
  if (!reply) return;
  if (isSupabaseConfigured() && contactId && tenantId !== "default-tenant") {
    await appendMessage({
      tenantId,
      contactId,
      channel,
      direction: "outbound",
      body: reply,
      playbook,
    });
    return;
  }
  appendToThread(tenantId, threadKey, { role: "assistant", content: reply });
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
    await persistInbound({
      tenantId,
      threadKey,
      contactId: ctx.contactId,
      channel,
      userBody: body,
    });
    await persistOutbound({
      tenantId,
      threadKey,
      contactId: ctx.contactId,
      channel,
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

  // Always store the lead's message first so a later LLM failure still shows in CRM.
  await persistInbound({
    tenantId,
    threadKey,
    contactId: ctx.contactId,
    channel,
    userBody: body,
  });

  if (playbook === "none") {
    return {
      reply: "",
      playbook: "none",
      contactId: ctx.contactId,
      optedOut: false,
    };
  }

  const history = await loadHistory(tenantId, threadKey, ctx.contactId);
  // History already includes the inbound we just saved — do not duplicate as userMessage.
  const historyWithoutCurrent = history.slice(0, -1);
  const last = history[history.length - 1];
  const userMessage =
    last?.role === "user" && typeof last.content === "string"
      ? last.content
      : body;

  let reply = "";
  let toolCalls: Awaited<ReturnType<typeof runAgentTurn>>["toolCalls"] = [];

  try {
    const turn = await runAgentTurn(
      playbook,
      historyWithoutCurrent,
      userMessage,
      buildContextBlock(ctx, channel),
      {
        tenantId,
        contactId: ctx.contactId,
        email: ctx.email,
        leadName: [ctx.firstName, ctx.lastName].filter(Boolean).join(" ") || undefined,
      },
    );
    reply = turn.reply;
    toolCalls = turn.toolCalls;
  } catch (error) {
    console.error("Inbound agent turn failed:", error);
    reply =
      "Thanks for that. What area are you looking at, or what else can I help with?";
  }

  // Never escalate to booking/handoff just because they asked a question.
  if (looksLikeInfoQuestion(body)) {
    for (const tc of toolCalls) {
      if (tc.name !== "update_contact") continue;
      if (tc.args.ready_to_book === true) tc.args.ready_to_book = false;
      if (tc.args.handoff === true) delete tc.args.handoff;
    }
  }

  await persistOutbound({
    tenantId,
    threadKey,
    contactId: ctx.contactId,
    channel,
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
