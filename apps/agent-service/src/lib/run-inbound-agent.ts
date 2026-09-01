import type { ChatCompletionMessageParam } from "openai/resources/chat/completions";
import {
  resolvePlaybook,
  looksLikeInfoQuestion,
  wantsToSchedule,
  looksLikeScheduleAffirmation,
  lastOutboundWasSchedulingPrompt,
  looksLikeGratitude,
  looksLikeScheduleDecline,
  hasCoreIntake,
  mergeContactWithToolUpdates,
  ensureConsultAskInReply,
  replyOffersConsult,
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
  const lines = [
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
  ];

  if (
    hasCoreIntake(ctx) &&
    !ctx.apptBooked &&
    !ctx.readyToBook &&
    !ctx.handoff
  ) {
    lines.push(
      "SCHEDULING REQUIRED THIS TURN: Core intake is complete. Your reply MUST ask if they want help picking a consult time (e.g. Want me to help pick a consult time?). Do NOT ask another qualification question instead.",
    );
  }

  return lines.filter(Boolean).join("\n");
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

  // Peek last assistant line before routing (inbound not persisted yet).
  const historyPeek = await loadHistory(tenantId, threadKey, ctx.contactId);
  const lastAssistant = [...historyPeek]
    .reverse()
    .find((m) => m.role === "assistant");
  const lastAssistantText =
    typeof lastAssistant?.content === "string" ? lastAssistant.content : "";

  const scheduleIntent =
    !ctx.apptBooked &&
    !looksLikeGratitude(body) &&
    (wantsToSchedule(body) ||
      (looksLikeScheduleAffirmation(body) &&
        (ctx.readyToBook ||
          lastOutboundWasSchedulingPrompt(lastAssistantText))));

  // Re-open booking when they ask to schedule (even after a prior handoff).
  // Never reopen on gratitude or when already booked unless they asked to reschedule.
  if (scheduleIntent && ctx.contactId) {
    const patch: Record<string, boolean> = {};
    if (ctx.handoff) {
      patch.handoff = false;
      ctx.handoff = false;
    }
    if (!ctx.readyToBook) {
      patch.ready_to_book = true;
      ctx.readyToBook = true;
    }
    if (Object.keys(patch).length > 0) {
      await updateContactFields(ctx.contactId, patch);
    }
  }

  // Stuck ready_to_book after a successful book → clear so Follow-Up owns the thread.
  if (
    ctx.apptBooked &&
    ctx.readyToBook &&
    !wantsToSchedule(body) &&
    ctx.contactId
  ) {
    await updateContactFields(ctx.contactId, { ready_to_book: false });
    ctx.readyToBook = false;
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
    !scheduleIntent &&
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
  if (looksLikeInfoQuestion(body) && !scheduleIntent) {
    for (const tc of toolCalls) {
      if (tc.name !== "update_contact") continue;
      if (tc.args.ready_to_book === true) tc.args.ready_to_book = false;
      if (tc.args.handoff === true) delete tc.args.handoff;
    }
  }

  // Scheduling path: keep ready_to_book while actively booking — never after a book.
  const bookedThisTurn = toolCalls.some((tc) => tc.name === "book_appointment");
  const replyLooksBooked =
    /\b(booked|you'?re all set|invite (was )?sent|confirmed for|on the calendar)\b/i.test(
      reply,
    );
  if (bookedThisTurn || replyLooksBooked || ctx.apptBooked) {
    let sawUpdate = false;
    for (const tc of toolCalls) {
      if (tc.name !== "update_contact") continue;
      sawUpdate = true;
      tc.args.ready_to_book = false;
      if (bookedThisTurn || replyLooksBooked) tc.args.appt_booked = true;
      if (tc.args.handoff === true) tc.args.handoff = false;
    }
    if (!sawUpdate && (bookedThisTurn || replyLooksBooked) && ctx.contactId) {
      toolCalls.push({
        name: "update_contact",
        args: { ready_to_book: false, appt_booked: true },
      });
    }
    // Never re-ask for mornings after a successful book.
    if (
      /mornings or afternoons|pull real open times|day you prefer/i.test(reply)
    ) {
      reply = replyLooksBooked
        ? reply
        : "You're all set. Looking forward to the consult. Reply here if you need anything before then.";
    }
  } else if ((scheduleIntent || playbook === "scheduler") && !ctx.apptBooked) {
    let sawUpdate = false;
    for (const tc of toolCalls) {
      if (tc.name !== "update_contact") continue;
      sawUpdate = true;
      tc.args.ready_to_book = true;
      if (tc.args.handoff === true) tc.args.handoff = false;
    }
    if (!sawUpdate && scheduleIntent && playbook === "scheduler") {
      toolCalls.push({
        name: "update_contact",
        args: { ready_to_book: true, handoff: false },
      });
    }
  }

  // Must ask for a consult once core intake is filled (code-enforced).
  if (
    (playbook === "concierge" || playbook === "follow_up") &&
    !bookedThisTurn &&
    !replyLooksBooked &&
    !ctx.apptBooked &&
    !looksLikeScheduleDecline(body)
  ) {
    const merged = mergeContactWithToolUpdates(ctx, toolCalls);
    const shouldAsk =
      hasCoreIntake(merged) &&
      !merged.apptBooked &&
      !merged.readyToBook &&
      !historyAlreadyAskedConsult(historyWithoutCurrent);
    reply = ensureConsultAskInReply(reply, shouldAsk);
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

function historyAlreadyAskedConsult(
  history: Array<{ role?: string; content?: unknown }>,
): boolean {
  // If we already asked in the last 4 assistant turns, don't spam — unless they
  // never got a clear ask (replyOffersConsult). One prior ask is enough for now.
  let assistantSeen = 0;
  for (let i = history.length - 1; i >= 0 && assistantSeen < 4; i--) {
    const m = history[i];
    if (m.role !== "assistant") continue;
    assistantSeen += 1;
    if (typeof m.content === "string" && replyOffersConsult(m.content)) {
      return true;
    }
  }
  return false;
}
