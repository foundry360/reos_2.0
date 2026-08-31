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

const INFO_QUESTION_START =
  /^(do you|does|can you|could you|what|when|where|how|why|are you|is it|who|tell me|explain|will you|would you|have you|any chance|i (was )?wondering)/i;

/** True when the inbound looks like booking logistics, not a general question. */
export function looksLikeSchedulingMessage(body: string): boolean {
  return SCHEDULING_HINT.test(body.trim());
}

/**
 * True when the inbound is an informational question that Concierge should answer,
 * even if ready_to_book is stuck true.
 */
export function looksLikeInfoQuestion(body: string): boolean {
  const t = body.trim();
  if (!t) return false;
  if (looksLikeSchedulingMessage(t)) return false;
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
