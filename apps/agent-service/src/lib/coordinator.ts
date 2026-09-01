/** Agent playbooks — mirrors GHL Concierge / Scheduler / Follow-Up routing. */
export type AgentPlaybook = "concierge" | "scheduler" | "follow_up" | "none";

/** Lead pipeline statuses (CRM UI). Routing also uses boolean flags below. */
export type LeadStatus =
  | "New"
  | "Working"
  | "Contacted"
  | "Qualified"
  | "Converted";

export type LeadTemperature = "Hot" | "Warm" | "Cold";

export type LeadIntent = "Buyer" | "Seller" | "Investor" | "Referral";

export interface ContactContext {
  contactId?: string;
  accountId?: string;
  phone: string;
  firstName?: string;
  lastName?: string;
  email?: string;
  leadStatus: LeadStatus;
  leadTemperature?: LeadTemperature | null;
  readyToBook: boolean;
  apptBooked: boolean;
  handoff: boolean;
  optedOut: boolean;
  intent?: LeadIntent | null;
  aiSummary?: string;
  agentBrief?: string;
  recommendedNextAction?: string;
  qualificationScore?: number | null;
  targetLocation?: string;
  propertyType?: string;
  budget?: string;
  timeline?: string;
  financingStatus?: string;
  mustHaves?: string;
  motivation?: string;
  preferences?: string;
}

const SCHEDULING_HINT =
  /\b(morning|afternoon|evening|schedule|schedul|book(ing)?|appointment|consult|calendar|available|availability|monday|tuesday|wednesday|thursday|friday|saturday|sunday|tomorrow|next week|\d{1,2}(:\d{2})?\s*(am|pm))\b/i;

/** Lead is asking to book / meet (not just chatting about mornings in general). */
const WANTS_SCHEDULE =
  /\b((let'?s|can we|could we|want to|wanna|need to|ready to)\s+(schedule|book|meet|set\s*up)|schedule\s+(a\s+)?(consult|call|meeting|appointment)|book\s+(a\s+)?(consult|call|meeting|appointment)|set\s*up\s+(a\s+)?(consult|call|meeting)|pick\s+a\s+time|find\s+a\s+time)\b/i;

const SHORT_AFFIRM =
  /^(yes|yeah|yep|yup|sure|ok|okay|sounds good|that works|absolutely|please|perfect|great)([.!]|\s+please)?$/i;

const SCHEDULE_PROMPT_HINT =
  /\b(mornings or afternoons|morning or afternoon|works better|what day|which day|prefer|open times|available times|pull .* times|do mornings)\b/i;

const BOOKING_CONFIRM_HINT =
  /\b(booked|you'?re all set|invite (was )?sent|confirmed for|on the calendar)\b/i;

const GRATITUDE_ONLY =
  /^(thanks|thank you|thx|ty|thankyou|appreciate it|appreciated)([.! ]*(so much|again)?)?[.!]?$/i;

const INFO_QUESTION_START =
  /^(do you|does|can you|could you|what|when|where|how|why|are you|is it|who|tell me|explain|will you|would you|have you|any chance|i (was )?wondering)/i;

/** True when the inbound looks like booking logistics, not a general question. */
export function looksLikeSchedulingMessage(body: string): boolean {
  return SCHEDULING_HINT.test(body.trim());
}

/** True when the lead is explicitly asking to schedule a consult/meeting. */
export function wantsToSchedule(body: string): boolean {
  return WANTS_SCHEDULE.test(body.trim());
}

/** Short yes/ok after the agent asked about mornings/scheduling. */
export function looksLikeScheduleAffirmation(body: string): boolean {
  return SHORT_AFFIRM.test(body.trim());
}

/** Last outbound was asking about scheduling preference / times. */
export function lastOutboundWasSchedulingPrompt(
  lastAssistantContent: string | undefined | null,
): boolean {
  if (!lastAssistantContent?.trim()) return false;
  if (BOOKING_CONFIRM_HINT.test(lastAssistantContent)) return false;
  return SCHEDULE_PROMPT_HINT.test(lastAssistantContent);
}

/** Polite close after a booking — not a schedule request. */
export function looksLikeGratitude(body: string): boolean {
  return GRATITUDE_ONLY.test(body.trim());
}

const SCHEDULE_OFFER_IN_REPLY =
  /\b(consult(ation)?|appointment|pick a time|book a (time|consult|call)|schedule (a |an )?(consult|call|meeting|appointment)|get .* on the calendar|want me to help (you )?(pick|schedule|book))\b/i;

const SCHEDULE_DECLINE =
  /\b(not (right )?now|no thanks|no thank you|maybe later|later|don'?t want to (meet|schedule|book)|do not want to (meet|schedule|book)|pass for now)\b/i;

export function replyOffersConsult(reply: string): boolean {
  return SCHEDULE_OFFER_IN_REPLY.test(reply);
}

export function looksLikeScheduleDecline(body: string): boolean {
  return SCHEDULE_DECLINE.test(body.trim());
}

/** Merge CRM context with update_contact args from this turn. */
export function mergeContactWithToolUpdates(
  ctx: ContactContext,
  toolCalls: Array<{ name: string; args: Record<string, unknown> }>,
): ContactContext {
  const next: ContactContext = { ...ctx };
  for (const call of toolCalls) {
    if (call.name !== "update_contact") continue;
    const a = call.args;
    if (typeof a.intent === "string") next.intent = a.intent as LeadIntent;
    if (typeof a.target_location === "string" && a.target_location.trim()) {
      next.targetLocation = a.target_location.trim();
    }
    if (typeof a.property_type === "string" && a.property_type.trim()) {
      next.propertyType = a.property_type.trim();
    }
    if (typeof a.budget === "string" && a.budget.trim()) {
      next.budget = a.budget.trim();
    }
    if (typeof a.timeline === "string" && a.timeline.trim()) {
      next.timeline = a.timeline.trim();
    }
    if (typeof a.financing_status === "string" && a.financing_status.trim()) {
      next.financingStatus = a.financing_status.trim();
    }
    if (typeof a.motivation === "string" && a.motivation.trim()) {
      next.motivation = a.motivation.trim();
    }
    if (typeof a.preferences === "string" && a.preferences.trim()) {
      next.preferences = a.preferences.trim();
    }
    if (typeof a.must_haves === "string" && a.must_haves.trim()) {
      next.mustHaves = a.must_haves.trim();
    }
    if (typeof a.email === "string" && a.email.trim()) {
      next.email = a.email.trim().toLowerCase();
    }
    if (typeof a.ai_summary === "string" && a.ai_summary.trim()) {
      next.aiSummary = a.ai_summary.trim();
    }
    if (a.ready_to_book === true) next.readyToBook = true;
    if (a.appt_booked === true) next.apptBooked = true;
  }
  return next;
}

/**
 * Enough CRM fields to offer a consult (ignores ready_to_book / handoff gates).
 */
export function hasCoreQualificationFields(ctx: ContactContext): boolean {
  const has = (v?: string | null) => Boolean(v?.trim());
  const summary = ctx.aiSummary ?? "";
  const intent = ctx.intent;

  if (intent === "Seller") {
    return (
      (has(ctx.motivation) ||
        /\baddress\b/i.test(summary) ||
        has(ctx.targetLocation)) &&
      (has(ctx.timeline) || has(ctx.motivation))
    );
  }

  if (intent === "Investor") {
    return (
      has(ctx.budget) &&
      (has(ctx.preferences) || has(ctx.targetLocation) || has(ctx.mustHaves)) &&
      (has(ctx.motivation) || /strateg/i.test(summary) || has(ctx.preferences))
    );
  }

  const financingOk =
    has(ctx.financingStatus) ||
    /\b(pre-?approved|cash buyer|paying cash|needs financing|pre-?qualified|conventional|fha|va loan)\b/i.test(
      summary,
    );
  return (
    has(ctx.targetLocation) &&
    has(ctx.propertyType) &&
    has(ctx.budget) &&
    financingOk
  );
}

/**
 * True when we should push a consult ask this turn.
 */
export function hasCoreIntake(ctx: ContactContext): boolean {
  if (ctx.apptBooked || ctx.readyToBook || ctx.handoff || ctx.optedOut) {
    return false;
  }
  return hasCoreQualificationFields(ctx);
}

export const SCHEDULE_ASK_LINE =
  "Want me to help pick a consult time that works for you?";

/** Append a consult ask when the model skipped it after core intake. */
export function ensureConsultAskInReply(
  reply: string,
  shouldAsk: boolean,
): string {
  if (!shouldAsk) return reply;
  if (replyOffersConsult(reply)) return reply;
  const base = reply.trim();
  if (!base) return SCHEDULE_ASK_LINE;
  return `${base.replace(/[.!?]?$/, ".")} ${SCHEDULE_ASK_LINE}`;
}

export const CONTACT_INFO_ASK_BOTH =
  "What's the best email and mobile for you?";

export const CONTACT_INFO_ASK_EMAIL =
  "What's the best email for you?";

export const CONTACT_INFO_ASK_PHONE =
  "What's the best mobile number for you?";

const CONTACT_INFO_ASK_HINT =
  /\b(best (email|e-mail|mobile|phone)|email and (mobile|phone)|mobile (number|for you)|phone (number|for you)|email or (mobile|phone)|reach you (at|by))\b/i;

/** True when the outbound already asks for email and/or phone. */
export function replyAsksForContactInfo(reply: string): boolean {
  const t = reply.trim();
  if (!t) return false;
  if (CONTACT_INFO_ASK_HINT.test(t)) return true;
  const asksEmail =
    /\b(email|e-mail)\b/i.test(t) &&
    /\b(what|what'?s|got|share|send|drop|give)\b/i.test(t);
  // Do not treat bare "number" (e.g. "how many bedrooms") as a phone ask.
  const asksPhone =
    /\b(mobile|cell|phone(\s*number)?)\b/i.test(t) &&
    /\b(what|what'?s|got|share|send|drop|give)\b/i.test(t);
  return asksEmail || asksPhone;
}

export function looksLikeContactInfoDecline(body: string): boolean {
  const t = body.trim();
  if (!t) return false;
  return /\b(no thanks|no thank you|i'?d rather not|rather skip|prefer not|don'?t (want|wanna) (to )?(share|give)|skip( that| for now)?|not (giving|sharing)|no email|no phone|keep it private)\b/i.test(
    t,
  );
}

export function contactInfoAskLine(options: {
  needEmail: boolean;
  needPhone: boolean;
}): string {
  if (options.needEmail && options.needPhone) return CONTACT_INFO_ASK_BOTH;
  if (options.needEmail) return CONTACT_INFO_ASK_EMAIL;
  if (options.needPhone) return CONTACT_INFO_ASK_PHONE;
  return CONTACT_INFO_ASK_BOTH;
}

/** Append an email/phone ask when the model skipped it — and strip other questions. */
export function ensureContactInfoAskInReply(
  reply: string,
  shouldAsk: boolean,
  options: { needEmail: boolean; needPhone: boolean },
): string {
  if (!shouldAsk) return reply;
  const line = contactInfoAskLine(options);
  const base = reply.trim();
  if (!base) return line;

  // Already asking for contact info — still drop other trailing qual questions.
  if (replyAsksForContactInfo(base)) {
    const sentences = splitSentences(base);
    const kept = sentences.filter((s) => {
      if (!s.includes("?")) return true;
      return replyAsksForContactInfo(s);
    });
    const stem = kept.join(" ").trim();
    return stem || line;
  }

  // Model asked area / type / timeline / etc. instead — keep short ack, force contact ask.
  const sentences = splitSentences(base);
  const acknowledgements = sentences.filter((s) => !s.includes("?"));
  let stem = acknowledgements.join(" ").trim();
  if (!stem) {
    // e.g. only a question — soften to a one-line ack
    stem = "Sounds good.";
  }
  return `${stem.replace(/[.!?]?$/, ".")} ${line}`;
}

function splitSentences(text: string): string[] {
  return text
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * True when Concierge must ask for email/mobile this turn.
 * Fires every turn until asked once (including the first reply) — before deep qual.
 */
export function shouldAskContactInfo(options: {
  channel: "sms" | "messenger" | "instagram";
  ctx: ContactContext;
  hasSmsIdentity: boolean;
  priorAssistantTurns: number;
  alreadyAsked: boolean;
  declined: boolean;
  phoneJustSaved: boolean;
}): boolean {
  const { channel, ctx, hasSmsIdentity, alreadyAsked, declined, phoneJustSaved } =
    options;
  if (declined || alreadyAsked) return false;
  if (ctx.optedOut || ctx.apptBooked || ctx.handoff || ctx.readyToBook) {
    return false;
  }
  const needEmail = !ctx.email?.trim();
  const needPhone =
    channel !== "sms" && !hasSmsIdentity && !phoneJustSaved;
  return needEmail || needPhone;
}

/**
 * True when the inbound is an informational question that Concierge should answer,
 * even if ready_to_book is stuck true.
 */
export function looksLikeInfoQuestion(body: string): boolean {
  const t = body.trim();
  if (!t) return false;
  if (wantsToSchedule(t) || looksLikeSchedulingMessage(t)) return false;
  if (looksLikeScheduleAffirmation(t)) return false;
  if (t.includes("?")) return true;
  return INFO_QUESTION_START.test(t);
}

/**
 * Coordinator routing — first match wins.
 * Source: docs/ghl-agent-reference.md §2
 *
 * Keep New/Working on Concierge even if temperature was set mid-qualification.
 * If ready_to_book is true but the lead asks an info question, stay on Concierge
 * so Scheduler does not refuse-and-deflect.
 *
 * Note: callers should clear handoff + set ready_to_book when the lead wants to
 * schedule again (handoff must not permanently block booking).
 */
export function resolvePlaybook(
  ctx: ContactContext,
  inboundBody?: string,
): AgentPlaybook {
  if (ctx.optedOut) return "none";
  if (ctx.handoff) return "none";

  // Already booked: Follow-Up owns thanks / logistics unless they ask to reschedule.
  if (ctx.apptBooked && !(inboundBody && wantsToSchedule(inboundBody))) {
    return "follow_up";
  }

  if (ctx.readyToBook) {
    if (inboundBody && looksLikeInfoQuestion(inboundBody)) {
      return "concierge";
    }
    return "scheduler";
  }

  // Explicit schedule request before ready_to_book is flipped (same turn / race).
  if (inboundBody && wantsToSchedule(inboundBody)) {
    return "scheduler";
  }

  if (ctx.apptBooked) return "follow_up";

  const temp = ctx.leadTemperature;
  const stillQualifying =
    ctx.leadStatus === "New" ||
    ctx.leadStatus === "Working" ||
    // Keep Concierge until core intake is done so the consult ask can fire.
    (ctx.leadStatus === "Qualified" &&
      hasCoreQualificationFields(ctx) === false);
  if (
    (temp === "Warm" || temp === "Cold") &&
    !ctx.readyToBook &&
    !stillQualifying
  ) {
    return "follow_up";
  }

  // Closed deal without an appointment thread to service
  if (ctx.leadStatus === "Converted" && !ctx.apptBooked) return "none";

  return "concierge";
}
