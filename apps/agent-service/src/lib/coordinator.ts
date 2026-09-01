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
  /\b(morning|afternoon|schedule|book|consult|calendar|available|time work|works better)\b/i;

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
  return SCHEDULE_PROMPT_HINT.test(lastAssistantContent);
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
    ctx.leadStatus === "New" || ctx.leadStatus === "Working";
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
