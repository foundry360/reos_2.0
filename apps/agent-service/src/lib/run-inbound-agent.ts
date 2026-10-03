import type { ChatCompletionMessageParam } from "openai/resources/chat/completions";
import {
  resolvePlaybook,
  looksLikeInfoQuestion,
  wantsToSchedule,
  looksLikeSchedulingMessage,
  looksLikeScheduleAffirmation,
  lastOutboundWasSchedulingPrompt,
  lastOutboundOfferedTimes,
  namesSpecificTime,
  looksLikeGratitude,
  looksLikeScheduleDecline,
  hasCoreIntake,
  mergeContactWithToolUpdates,
  ensureConsultAskInReply,
  ensureContactInfoAskInReply,
  shouldAskContactInfo,
  replyAsksForContactInfo,
  looksLikeContactInfoDecline,
  replyOffersConsult,
  type AgentPlaybook,
  type ContactContext,
} from "@/lib/coordinator";
import { extractQualificationFromInbound } from "@/lib/extract-qualification";
import { runAgentTurn } from "@/lib/llm/openai";
import { describeWorkingHours } from "@/lib/calendar/working-hours";
import { describePostForAgent } from "@/lib/meta/post-context";
import type { AgentBackend } from "@/lib/agent/backend";
import { applyCompliance } from "@/lib/agent/compliance";
import { tenantAgentVersion } from "@/lib/agent/agent-version";
import { liveBackend } from "@/lib/agent/live-backend";
import { runLeadAgent } from "@/lib/agent/run-lead-agent";

export type AgentChannel = "sms" | "messenger" | "instagram";

export interface InboundAgentResult {
  reply: string;
  playbook: AgentPlaybook;
  contactId?: string;
  /** True when compliance blocked the agent (opt-out). */
  optedOut: boolean;
}

function buildContextBlock(
  ctx: ContactContext,
  channel: AgentChannel,
  options?: { hasSmsIdentity?: boolean; priorAssistantTurns?: number; note?: string },
): string {
  const hasSmsIdentity = options?.hasSmsIdentity ?? channel === "sms";
  const needEmail = !ctx.email?.trim();
  const needPhone = channel !== "sms" && !hasSmsIdentity;
  const lines = [
    `Channel: ${channel}`,
    options?.note ?? null,
    `External id: ${ctx.phone}`,
    ctx.firstName ? `First name: ${ctx.firstName}` : null,
    ctx.lastName ? `Last name: ${ctx.lastName}` : null,
    ctx.email
      ? `Email: ${ctx.email}`
      : "Email: (missing — ask once early)",
    channel === "sms" || hasSmsIdentity
      ? "Phone: (mobile on file / SMS thread)"
      : "Phone: (missing — ask once early for mobile)",
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
    (needEmail || needPhone) &&
    !ctx.apptBooked &&
    !ctx.readyToBook &&
    !ctx.handoff
  ) {
    lines.push(
      needEmail && needPhone
        ? "CONTACT INFO REQUIRED THIS TURN (HARD): Your ONLY question this turn must be for email AND mobile (e.g. What's the best email and mobile for you?). Do NOT ask area, property type, timeline, budget, or financing until after that ask. Do not offer to skip."
        : needEmail
          ? "CONTACT INFO REQUIRED THIS TURN (HARD): Your ONLY question this turn must be for email. Do NOT ask area/type/timeline/budget until after. Do not offer to skip."
          : "CONTACT INFO REQUIRED THIS TURN (HARD): Your ONLY question this turn must be for mobile. Do NOT ask area/type/timeline/budget until after. Do not offer to skip.",
    );
  }

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
  backend: AgentBackend,
  threadKey: string,
  contactId?: string,
): Promise<ChatCompletionMessageParam[]> {
  return sanitizeChatHistory(await backend.loadMessages({ threadKey, contactId }));
}

export async function persistInbound(
  backend: AgentBackend,
  params: {
    threadKey: string;
    contactId?: string;
    channel: string;
    userBody: string;
    contextLabel?: string | null;
  },
): Promise<void> {
  await backend.appendMessage({
    threadKey: params.threadKey,
    contactId: params.contactId,
    channel: params.channel,
    direction: "inbound",
    body: params.userBody,
    contextLabel: params.contextLabel,
  });
}

export async function persistOutbound(
  backend: AgentBackend,
  params: {
    threadKey: string;
    contactId?: string;
    channel: AgentChannel;
    reply: string;
    playbook: AgentPlaybook;
  },
): Promise<void> {
  if (!params.reply) return;
  await backend.appendMessage({
    threadKey: params.threadKey,
    contactId: params.contactId,
    channel: params.channel,
    direction: "outbound",
    body: params.reply,
    playbook: params.playbook,
  });
}

/**
 * Shared conversational agent loop for SMS + Meta.
 * Caller resolves ContactContext; this handles compliance → route → LLM → CRM tools → persist.
 */
export async function runInboundAgent(params: {
  ctx: ContactContext;
  body: string;
  channel: AgentChannel;
  /** Channel the inbound is stored under when it differs from the reply channel (e.g. a post comment). */
  inboundChannel?: string;
  /** Extra line for the model's context block. */
  contextNote?: string;
  /** Label stored with the inbound message, e.g. the property a comment was on. */
  inboundContextLabel?: string | null;
  /** contextNote already describes the post, so skip the stored property-of-interest lookup. */
  includesPostContext?: boolean;
  /** Side-effect layer; defaults to live Supabase. Evals pass a sandbox. */
  backend?: AgentBackend;
  /** Override the configured OpenAI model (evals). */
  model?: string;
}): Promise<InboundAgentResult> {
  const { ctx, body, channel } = params;
  const inboundChannel = params.inboundChannel ?? channel;
  const tenantId = ctx.accountId ?? "default-tenant";
  const threadKey = ctx.phone;

  if (!params.backend && (await tenantAgentVersion(tenantId)) === 2) {
    return runLeadAgent({ ...params, channel });
  }

  const backend = params.backend ?? liveBackend(tenantId);

  const alreadyOptedOut = ctx.optedOut;
  if (await applyCompliance(backend, ctx, body)) {
    const reply = alreadyOptedOut ? "" : "You have been unsubscribed.";
    await persistInbound(backend, {
      threadKey,
      contactId: ctx.contactId,
      channel: inboundChannel,
      userBody: body,
      contextLabel: params.inboundContextLabel,
    });
    await persistOutbound(backend, {
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
  const historyPeek = await loadHistory(backend, threadKey, ctx.contactId);
  const lastAssistant = [...historyPeek]
    .reverse()
    .find((m) => m.role === "assistant");
  const lastAssistantText =
    typeof lastAssistant?.content === "string" ? lastAssistant.content : "";

  const scheduleIntent =
    !ctx.apptBooked &&
    !looksLikeGratitude(body) &&
    (wantsToSchedule(body) ||
      (lastOutboundOfferedTimes(lastAssistantText) && !looksLikeScheduleDecline(body)) ||
      (looksLikeSchedulingMessage(body) &&
        !looksLikeScheduleDecline(body) &&
        lastOutboundWasSchedulingPrompt(lastAssistantText)) ||
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
      await backend.patchContact(ctx.contactId, patch);
    }
  }

  // Stuck ready_to_book after a successful book → clear so Follow-Up owns the thread.
  if (
    ctx.apptBooked &&
    ctx.readyToBook &&
    !wantsToSchedule(body) &&
    ctx.contactId
  ) {
    await backend.patchContact(ctx.contactId, { ready_to_book: false });
    ctx.readyToBook = false;
  }

  let playbook = resolvePlaybook(ctx, body);
  if (playbook !== "none" && !(await backend.playbookEnabled(playbook))) {
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
    await backend.patchContact(ctx.contactId, { ready_to_book: false });
    ctx.readyToBook = false;
  }

  // Always store the lead's message first so a later LLM failure still shows in CRM.
  await persistInbound(backend, {
    threadKey,
    contactId: ctx.contactId,
    channel: inboundChannel,
    userBody: body,
    contextLabel: params.inboundContextLabel,
  });

  if (playbook === "none") {
    return {
      reply: "",
      playbook: "none",
      contactId: ctx.contactId,
      optedOut: false,
    };
  }

  const history = await loadHistory(backend, threadKey, ctx.contactId);
  // History already includes the inbound we just saved — do not duplicate as userMessage.
  const historyWithoutCurrent = history.slice(0, -1);
  const last = history[history.length - 1];
  const userMessage =
    last?.role === "user" && typeof last.content === "string"
      ? last.content
      : body;

  const priorAssistantTurns = historyWithoutCurrent.filter(
    (m) => m.role === "assistant",
  ).length;
  const hasSmsIdentity =
    channel === "sms" ||
    (ctx.contactId ? await backend.hasSmsIdentity(ctx.contactId) : false);

  // Capture email / phone as soon as they share it (before booking tools run).
  const inboundEmail = extractEmailAddress(body);
  const inboundPhone = extractPhoneNumber(body);
  if (
    inboundEmail &&
    ctx.contactId &&
    inboundEmail !== (ctx.email ?? "").toLowerCase() &&
    (playbook === "scheduler" || scheduleIntent || playbook === "concierge")
  ) {
    await backend.patchContact(ctx.contactId, { email: inboundEmail });
    ctx.email = inboundEmail;
    ctx.contactId = await backend.reconcileContact(ctx.contactId, {
      email: inboundEmail,
    });
  }

  let reply = "";
  let toolCalls: Awaited<ReturnType<typeof runAgentTurn>>["toolCalls"] = [];
  let bookingSucceeded = false;

  const propertyInterest = params.includesPostContext
    ? null
    : await backend.propertyInterest(ctx.contactId);
  const note = [
    await todayLine(backend),
    params.contextNote,
    propertyInterest
      ? describePostForAgent(propertyInterest).replace(
          "POST THEY COMMENTED ON",
          "PROPERTY OF INTEREST (from their earlier comment)",
        )
      : null,
  ]
    .filter(Boolean)
    .join("\n");

  try {
    const turn = await runAgentTurn(
      playbook,
      historyWithoutCurrent,
      userMessage,
      buildContextBlock(ctx, channel, {
        hasSmsIdentity,
        priorAssistantTurns,
        note,
      }),
      {
        tenantId,
        contactId: ctx.contactId,
        email: ctx.email,
        phoneOnFile: hasSmsIdentity || Boolean(inboundPhone),
        forceBooking: playbook === "scheduler" && namesSpecificTime(userMessage),
        leadName: [ctx.firstName, ctx.lastName].filter(Boolean).join(" ") || undefined,
        backend,
        model: params.model,
      },
    );
    reply = turn.reply;
    toolCalls = turn.toolCalls;
    bookingSucceeded = turn.bookingSucceeded === true;
  } catch (error) {
    console.error("Inbound agent turn failed:", error);
    reply =
      "Thanks for that. What area are you looking at, or what else can I help with?";
  }

  // If they typed a phone and the model forgot update_contact(phone), attach it.
  if (
    inboundPhone &&
    ctx.contactId &&
    (playbook === "concierge" || playbook === "scheduler" || scheduleIntent)
  ) {
    let sawPhone = false;
    for (const tc of toolCalls) {
      if (tc.name !== "update_contact") continue;
      sawPhone = true;
      if (!tc.args.phone) tc.args.phone = inboundPhone;
    }
    if (!sawPhone) {
      toolCalls.push({
        name: "update_contact",
        args: { phone: inboundPhone },
      });
    }
  }

  // If Concierge forgot update_contact for area / type / timeline / financing.
  if (playbook === "concierge" && ctx.contactId) {
    const extracted = extractQualificationFromInbound(body, lastAssistantText);
    const missing: Record<string, string> = {};
    if (extracted.target_location && !ctx.targetLocation) {
      missing.target_location = extracted.target_location;
    }
    if (extracted.property_type && !ctx.propertyType) {
      missing.property_type = extracted.property_type;
    }
    if (extracted.timeline && !ctx.timeline) {
      missing.timeline = extracted.timeline;
    }
    if (extracted.financing_status && !ctx.financingStatus) {
      missing.financing_status = extracted.financing_status;
    }

    if (Object.keys(missing).length > 0) {
      let sawUpdate = false;
      for (const tc of toolCalls) {
        if (tc.name !== "update_contact") continue;
        sawUpdate = true;
        for (const [key, value] of Object.entries(missing)) {
          if (!tc.args[key]) tc.args[key] = value;
        }
      }
      if (!sawUpdate) {
        toolCalls.push({ name: "update_contact", args: missing });
      }
    }
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
  // Only a book_appointment that returned ok counts — a failed attempt or a reply that
  // merely sounds booked must not flip appt_booked (that drops the lead out of scheduling).
  const bookedThisTurn = bookingSucceeded;
  const bookingAttemptFailed =
    !bookingSucceeded && toolCalls.some((tc) => tc.name === "book_appointment");
  const claimsBooked =
    /\b(you['’]?re (all set|booked|scheduled|confirmed)|(is|are|i['’]?ve|i have|have|has been|been) (now |all )?(booked|scheduled|confirmed|set up|reserved)|(scheduled|booked|confirmed) (you|your)|invite (was |has been )?sent|confirmed for|i['’]?ll (confirm|book|lock) (it|that|this)|one moment)\b/i.test(
      reply,
    );
  if (!bookedThisTurn) {
    for (const tc of toolCalls) {
      if (tc.name !== "update_contact") continue;
      delete tc.args.appt_booked;
      if (tc.args.lead_status === "Converted") delete tc.args.lead_status;
    }
    if (claimsBooked && !ctx.apptBooked) {
      reply = bookingAttemptFailed
        ? "Sorry, that time didn't go through on my end. Want me to pull the open times for that day so you can pick one?"
        : "Let me check the calendar. Which day works best, and do you prefer morning or afternoon?";
    }
  }
  const replyLooksBooked = bookedThisTurn;
  if (bookedThisTurn || ctx.apptBooked) {
    let sawUpdate = false;
    for (const tc of toolCalls) {
      if (tc.name !== "update_contact") continue;
      sawUpdate = true;
      tc.args.ready_to_book = false;
      if (bookedThisTurn) tc.args.appt_booked = true;
      if (tc.args.handoff === true) tc.args.handoff = false;
    }
    if (!sawUpdate && bookedThisTurn && ctx.contactId) {
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

  // Must ask for email/mobile early (code-enforced — model often skips the prompt).
  if (
    playbook === "concierge" &&
    !bookedThisTurn &&
    !replyLooksBooked &&
    !ctx.apptBooked &&
    !scheduleIntent
  ) {
    const merged = mergeContactWithToolUpdates(ctx, toolCalls);
    const phoneJustSaved = toolCalls.some(
      (tc) =>
        tc.name === "update_contact" &&
        typeof tc.args.phone === "string" &&
        tc.args.phone.trim().length > 0,
    );
    const needEmail = !merged.email?.trim();
    const needPhone =
      channel !== "sms" && !hasSmsIdentity && !phoneJustSaved && !inboundPhone;
    const shouldAsk = shouldAskContactInfo({
      channel,
      ctx: merged,
      hasSmsIdentity: hasSmsIdentity || Boolean(inboundPhone) || phoneJustSaved,
      priorAssistantTurns,
      alreadyAsked: historyAlreadyAskedContactInfo(historyWithoutCurrent),
      declined:
        looksLikeContactInfoDecline(body) ||
        historyAlreadyDeclinedContactInfo(historyWithoutCurrent),
      phoneJustSaved: phoneJustSaved || Boolean(inboundPhone),
    });
    reply = ensureContactInfoAskInReply(reply, shouldAsk, {
      needEmail,
      needPhone,
    });
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
      !historyAlreadyAskedConsult(historyWithoutCurrent) &&
      // Prefer finishing the contact-info ask before pushing consult.
      !replyAsksForContactInfo(reply);
    reply = ensureConsultAskInReply(reply, shouldAsk);
  }

  // Persist email shared during scheduling (model often books with attendee_email
  // but forgets update_contact).
  const emailFromMessage = extractEmailAddress(body);
  const emailFromTools =
    toolCalls
      .map((tc) => {
        if (tc.name === "book_appointment") {
          return extractEmailAddress(String(tc.args.attendee_email ?? ""));
        }
        if (tc.name === "update_contact") {
          return extractEmailAddress(String(tc.args.email ?? ""));
        }
        return null;
      })
      .find((e): e is string => Boolean(e)) ?? null;
  const emailToSave = emailFromTools || emailFromMessage;
  if (emailToSave && ctx.contactId) {
    let sawUpdate = false;
    for (const tc of toolCalls) {
      if (tc.name === "book_appointment" && !tc.args.attendee_email) {
        tc.args.attendee_email = emailToSave;
      }
      if (tc.name !== "update_contact") continue;
      sawUpdate = true;
      if (!tc.args.email) tc.args.email = emailToSave;
    }
    if (!sawUpdate) {
      toolCalls.push({
        name: "update_contact",
        args: { email: emailToSave },
      });
    }
  }

  await persistOutbound(backend, {
    threadKey,
    contactId: ctx.contactId,
    channel,
    reply,
    playbook,
  });
  const survivorId = await backend.applyToolCalls(ctx.contactId, toolCalls);
  if (survivorId) ctx.contactId = survivorId;

  return {
    reply,
    playbook,
    contactId: ctx.contactId,
    optedOut: false,
  };
}

async function todayLine(backend: AgentBackend): Promise<string> {
  const { timeZone, workingHours } = await backend.schedule();
  const today = new Intl.DateTimeFormat("en-US", {
    timeZone,
    weekday: "long",
    month: "long",
    day: "numeric",
    year: "numeric",
  }).format(backend.now());
  const showings = workingHours.showingsOnDaysOff
    ? " Showings can also be booked on days off."
    : "";
  return `Today: ${today} (${timeZone})\nTeam working hours: ${describeWorkingHours(workingHours)}.${showings}`;
}

function extractEmailAddress(text: string): string | null {
  const match = text.match(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i);
  return match ? match[0].toLowerCase() : null;
}

function extractPhoneNumber(text: string): string | null {
  const match = text.match(
    /(?:\+?1[-.\s]?)?(?:\(?\d{3}\)?[-.\s]?)\d{3}[-.\s]?\d{4}\b/,
  );
  if (!match) return null;
  const digits = match[0].replace(/\D/g, "");
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
  if (digits.length >= 10) return `+${digits}`;
  return null;
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

function historyAlreadyAskedContactInfo(
  history: Array<{ role?: string; content?: unknown }>,
): boolean {
  let assistantSeen = 0;
  for (let i = history.length - 1; i >= 0 && assistantSeen < 8; i--) {
    const m = history[i];
    if (m.role !== "assistant") continue;
    assistantSeen += 1;
    if (typeof m.content === "string" && replyAsksForContactInfo(m.content)) {
      return true;
    }
  }
  return false;
}

function historyAlreadyDeclinedContactInfo(
  history: Array<{ role?: string; content?: unknown }>,
): boolean {
  for (let i = history.length - 1; i >= 0; i--) {
    const m = history[i];
    if (m.role !== "user" || typeof m.content !== "string") continue;
    if (looksLikeContactInfoDecline(m.content)) return true;
  }
  return false;
}
