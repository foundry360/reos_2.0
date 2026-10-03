import OpenAI from "openai";
import type { ChatCompletionMessageParam, ChatCompletionTool } from "openai/resources/chat/completions";
import { LEAD_AGENT_SYSTEM } from "@/agents/lead-agent";
import {
  getOpenAIApiKey,
  getOpenAIModel,
  isOpenAIConfiguredAsync,
} from "@/lib/admin/platform-credentials";
import { formatSlotLabel } from "@/lib/calendar/consult-slots";
import { describeWorkingHours } from "@/lib/calendar/working-hours";
import { looksLikeSchedulingMessage, wantsToSchedule, type ContactContext } from "@/lib/coordinator";
import { meterUsage } from "@/lib/llm/usage-meter";
import { describePostForAgent } from "@/lib/meta/post-context";
import { stripChatMarkdown } from "@/lib/llm/openai";
import type { AgentBackend, ToolEvent, UpcomingAppointment } from "@/lib/agent/backend";
import { applyCompliance } from "@/lib/agent/compliance";
import { buildLeadContext, readConversationState } from "@/lib/agent/context";
import { buildChatHistory } from "@/lib/agent/history";
import { LEAD_TOOLS, runLeadTool, type LeadTurnState } from "@/lib/agent/lead-tools";
import { liveBackend } from "@/lib/agent/live-backend";
import {
  extractClockTimes,
  isAmbiguousPick,
  mightBeScheduling,
  pointsAtTime,
  replyViolations,
} from "@/lib/agent/reply-checks";

type Channel = "sms" | "messenger" | "instagram";

export interface LeadAgentResult {
  reply: string;
  playbook: "lead_agent" | "none";
  contactId?: string;
  optedOut: boolean;
}

const MAX_TOOL_ROUNDS = 5;

export function leadAgentModel(): string {
  return process.env.LEAD_AGENT_MODEL?.trim() || getOpenAIModel();
}

function extractEmail(text: string): string | null {
  const match = text.match(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i);
  if (!match || match.index == null) return null;
  // "J gelsomino@x.com" is a split address; saving the tail would be a guess, so let the agent confirm it.
  if (/(^|\s)[A-Z]\s$/i.test(text.slice(0, match.index))) return null;
  return match[0].toLowerCase();
}

function extractPhone(text: string): string | null {
  const match = text.match(/(?:\+?1[-.\s]?)?(?:\(?\d{3}\)?[-.\s]?)\d{3}[-.\s]?\d{4}\b/);
  if (!match) return null;
  const digits = match[0].replace(/\D/g, "");
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
  return null;
}

function allowedTimesFor(params: {
  events: ToolEvent[];
  priorEvents: ToolEvent[];
  upcoming: UpcomingAppointment[];
  userTexts: string[];
  hoursText: string;
  propertyText: string;
  timeZone: string;
}): Set<number> {
  const texts = [
    ...params.events.map((e) => JSON.stringify(e.result)),
    ...params.priorEvents.map((e) => JSON.stringify(e.result)),
    ...params.upcoming.map((a) => formatSlotLabel(a.start, params.timeZone)),
    ...params.userTexts,
    params.hoursText,
    params.propertyText,
  ];
  return new Set(texts.flatMap((t) => extractClockTimes(t)));
}

/**
 * Reasoning-era models (gpt-5+, o-series) reject temperature/max_tokens and count thinking toward the limit.
 * GPT-6 Luna only accepts function tools on Chat Completions with reasoning off; Sol/Astra need the Responses API.
 */
function samplingParams(model: string, maxTokens: number) {
  if (/^gpt-6-luna/.test(model)) {
    return { max_completion_tokens: maxTokens, reasoning_effort: "none" as unknown as "low" };
  }
  if (/^(gpt-5|o\d)/.test(model)) {
    return { max_completion_tokens: maxTokens * 6, reasoning_effort: "low" as const };
  }
  return { temperature: 0.2, max_tokens: maxTokens };
}

async function completeTurn(params: {
  client: OpenAI;
  model: string;
  messages: ChatCompletionMessageParam[];
  state: LeadTurnState;
  tools: ChatCompletionTool[];
}): Promise<string> {
  const { client, model, messages, state, tools } = params;
  let reply = "";
  for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
    const completion = await client.chat.completions.create({
      model,
      messages,
      tools,
      tool_choice: "auto",
      ...samplingParams(model, 600),
    });
    meterUsage(model, completion.usage);
    const msg = completion.choices[0]?.message;
    if (!msg) break;
    reply = msg.content?.trim() || "";
    if (!msg.tool_calls?.length) break;

    // Text written alongside tool calls is never sent; keeping it would make the model think it already answered.
    messages.push({ role: "assistant", content: null, tool_calls: msg.tool_calls });
    for (const call of msg.tool_calls) {
      if (call.type !== "function") continue;
      let args: Record<string, unknown> = {};
      try {
        args = JSON.parse(call.function.arguments || "{}") as Record<string, unknown>;
      } catch {
        args = {};
      }
      const result = await runLeadTool(state, call.function.name, args);
      messages.push({ role: "tool", tool_call_id: call.id, content: JSON.stringify(result) });
    }
  }
  if (!reply) {
    const final = await client.chat.completions.create({
      model,
      messages,
      tools,
      tool_choice: "none",
      ...samplingParams(model, 400),
    });
    meterUsage(model, final.usage);
    reply = final.choices[0]?.message?.content?.trim() || "";
  }
  return stripChatMarkdown(reply);
}

/**
 * Lead agent v2: one prompt with every tool, conversation state from saved tool events,
 * and a code-checked invariant guard that retries once with the problems spelled out.
 */
export async function runLeadAgent(params: {
  ctx: ContactContext;
  body: string;
  channel: Channel;
  inboundChannel?: string;
  contextNote?: string;
  inboundContextLabel?: string | null;
  includesPostContext?: boolean;
  backend?: AgentBackend;
  model?: string;
}): Promise<LeadAgentResult> {
  const { ctx, body, channel } = params;
  const tenantId = ctx.accountId ?? "default-tenant";
  const threadKey = ctx.phone;
  const backend = params.backend ?? liveBackend(tenantId);
  const inboundChannel = params.inboundChannel ?? channel;

  const saveInbound = () =>
    backend.appendMessage({
      threadKey,
      contactId: ctx.contactId,
      channel: inboundChannel,
      direction: "inbound",
      body,
      contextLabel: params.inboundContextLabel,
    });

  const alreadyOptedOut = ctx.optedOut;
  if (await applyCompliance(backend, ctx, body)) {
    await saveInbound();
    const reply = alreadyOptedOut ? "" : "You have been unsubscribed.";
    if (reply) {
      await backend.appendMessage({ threadKey, contactId: ctx.contactId, channel, direction: "outbound", body: reply, playbook: "none" });
    }
    return { reply, playbook: "none", contactId: ctx.contactId, optedOut: true };
  }

  const enabled = await Promise.all(
    ["concierge", "scheduler", "follow_up"].map((p) => backend.playbookEnabled(p)),
  );
  if (!enabled.some(Boolean)) {
    await saveInbound();
    return { reply: "", playbook: "none", contactId: ctx.contactId, optedOut: false };
  }

  // A team member owns the thread after a handoff, unless the lead asks to book again.
  if (ctx.handoff) {
    if (!wantsToSchedule(body) || !ctx.contactId) {
      await saveInbound();
      return { reply: "", playbook: "none", contactId: ctx.contactId, optedOut: false };
    }
    await backend.patchContact(ctx.contactId, { handoff: false });
    ctx.handoff = false;
  }

  await saveInbound();

  let phoneOnFile =
    channel === "sms" || (ctx.contactId ? await backend.hasSmsIdentity(ctx.contactId) : false);

  // Contact details typed into the chat are saved before the model runs, so booking sees them.
  const typedEmail = extractEmail(body);
  const typedPhone = extractPhone(body);
  const capture: Record<string, string> = {};
  if (typedEmail && typedEmail !== ctx.email?.toLowerCase()) capture.email = typedEmail;
  if (typedPhone && !phoneOnFile) capture.phone = typedPhone;
  if (ctx.contactId && Object.keys(capture).length > 0) {
    ctx.contactId =
      (await backend.applyToolCalls(ctx.contactId, [{ name: "update_contact", args: capture }])) ?? ctx.contactId;
  }
  if (capture.email) ctx.email = capture.email;
  if (capture.phone) phoneOnFile = true;

  const [messages, turns, schedule, upcoming, property] = await Promise.all([
    backend.loadMessages({ threadKey, contactId: ctx.contactId }),
    backend.recentTurns(ctx.contactId),
    backend.schedule(),
    backend.upcomingAppointments(ctx.contactId),
    params.includesPostContext ? Promise.resolve(null) : backend.propertyInterest(ctx.contactId),
  ]);

  if (!(await isOpenAIConfiguredAsync())) {
    return {
      reply: `[dev] Received: ${body}. Configure OPENAI_API_KEY for live replies.`,
      playbook: "lead_agent",
      contactId: ctx.contactId,
      optedOut: false,
    };
  }

  const history = buildChatHistory(messages, turns);
  // The inbound we just saved is the last user entry; it goes after the context instead.
  const lastUser = history.length > 0 && history[history.length - 1].role === "user" ? history.pop() : null;
  const userMessage = typeof lastUser?.content === "string" ? lastUser.content : body;

  const { offered, held } = readConversationState(turns);
  const firstReply = !messages.some((m) => m.role === "assistant") && upcoming.length === 0;
  // An opening "I'm interested" gets a greeting and a question, not a list of appointment times.
  const calendarAllowed =
    !firstReply || wantsToSchedule(body) || looksLikeSchedulingMessage(body) || mightBeScheduling(body);
  const tools = calendarAllowed
    ? LEAD_TOOLS
    : LEAD_TOOLS.filter((t) => t.type === "function" && t.function.name === "update_contact");
  const context = buildLeadContext({
    ctx,
    channel,
    schedule,
    now: backend.now(),
    phoneOnFile,
    upcoming,
    offered,
    held,
    property,
    firstReply,
    note: params.contextNote,
  });

  const model = params.model ?? leadAgentModel();
  const client = new OpenAI({ apiKey: await getOpenAIApiKey(), maxRetries: 5 });
  const state: LeadTurnState = {
    backend,
    contactId: ctx.contactId,
    email: ctx.email?.trim() || undefined,
    phoneOnFile,
    leadName: [ctx.firstName, ctx.lastName].filter(Boolean).join(" ") || undefined,
    events: [],
    booked: null,
    upcoming: upcoming.map((a) => ({ ...a })),
    ambiguousPick: isAmbiguousPick(
      userMessage,
      [...messages].reverse().find((m) => m.role === "assistant")?.content ?? "",
    ),
    leadPickedTime: Boolean(held) || pointsAtTime(userMessage),
    leadText: [...messages.filter((m) => m.role === "user").map((m) => m.content), userMessage].join("\n"),
  };
  const chat: ChatCompletionMessageParam[] = [
    { role: "system", content: `${LEAD_AGENT_SYSTEM}\n\n---\nCONTEXT\n${context}` },
    ...history,
    { role: "user", content: userMessage },
  ];

  const userTexts = [...messages.filter((m) => m.role === "user").map((m) => m.content), body];
  const guardInput = () => ({
    allowedTimes: allowedTimesFor({
      events: state.events,
      priorEvents: turns.flatMap((t) => t.toolEvents),
      upcoming,
      userTexts,
      hoursText: describeWorkingHours(schedule.workingHours),
      propertyText: property ? describePostForAgent(property) : "",
      timeZone: schedule.timeZone,
    }),
    bookedThisTurn: Boolean(state.booked),
    movedThisTurn: state.events.some(
      (e) => e.name === "reschedule_appointment" && (e.result as { ok?: boolean } | null)?.ok === true,
    ),
    hasAppointment: upcoming.length > 0,
    contactInfoOnFile: Boolean(state.email) && state.phoneOnFile,
    firstReply,
    leadInviteMissing: state.events.some(
      (e) =>
        (e.name === "book_appointment" || e.name === "reschedule_appointment") &&
        (e.result as { ok?: boolean; leadInviteSent?: boolean } | null)?.ok === true &&
        (e.result as { leadInviteSent?: boolean }).leadInviteSent === false,
    ),
  });

  let reply = "";
  try {
    reply = await completeTurn({ client, model, messages: chat, state, tools });
    const problems = replyViolations({ reply, ...guardInput() });
    if (problems.length > 0) {
      console.warn("lead agent guard retry:", JSON.stringify({ reply, problems }));
      chat.push({ role: "assistant", content: reply || "(empty)" });
      chat.push({
        role: "system",
        content: `Internal check, not from the lead. Your last draft was not sent because:\n- ${problems.join("\n- ")}\nUse tools if needed, then write the reply to send.`,
      });
      reply = await completeTurn({ client, model, messages: chat, state, tools });
      const remaining = replyViolations({ reply, ...guardInput() });
      if (remaining.length > 0) console.warn("lead agent guard still failing:", JSON.stringify({ reply, remaining }));
    }
  } catch (error) {
    console.error("Lead agent turn failed:", error);
  }

  ctx.contactId = state.contactId ?? ctx.contactId;
  if (state.email) ctx.email = state.email;

  await backend.recordTurn({ contactId: ctx.contactId, model, reply, toolEvents: state.events });
  if (reply) {
    await backend.appendMessage({
      threadKey,
      contactId: ctx.contactId,
      channel,
      direction: "outbound",
      body: reply,
      playbook: "lead_agent",
    });
  }

  return { reply, playbook: "lead_agent", contactId: ctx.contactId, optedOut: false };
}
