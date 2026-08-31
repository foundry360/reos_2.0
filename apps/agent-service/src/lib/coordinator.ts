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
}

/**
 * Coordinator routing — first match wins.
 * Source: docs/ghl-agent-reference.md §2
 */
export function resolvePlaybook(ctx: ContactContext): AgentPlaybook {
  if (ctx.optedOut) return "none";
  if (ctx.handoff) return "none";
  if (ctx.readyToBook) return "scheduler";
  if (ctx.apptBooked) return "follow_up";

  const temp = ctx.leadTemperature;
  if ((temp === "Warm" || temp === "Cold") && !ctx.readyToBook) {
    return "follow_up";
  }

  // Closed deal without an appointment thread to service
  if (ctx.leadStatus === "Converted" && !ctx.apptBooked) return "none";

  return "concierge";
}
