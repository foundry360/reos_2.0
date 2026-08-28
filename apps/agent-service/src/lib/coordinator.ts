/** Agent playbooks — mirrors GHL Concierge / Scheduler / Follow-Up routing. */
export type AgentPlaybook = "concierge" | "scheduler" | "follow_up" | "none";

/** Lead pipeline statuses. */
export type LeadStatus =
  | "New"
  | "Working"
  | "Contacted"
  | "Qualified"
  | "Converted";

export interface ContactContext {
  contactId?: string;
  accountId?: string;
  phone: string;
  firstName?: string;
  leadStatus: LeadStatus;
  optedOut: boolean;
  aiSummary?: string;
}

/**
 * Coordinator routing — first match wins.
 * Port of docs/prompts/coordinator.md (GHL REOS reference).
 */
export function resolvePlaybook(ctx: ContactContext): AgentPlaybook {
  if (ctx.optedOut) return "none";
  if (ctx.leadStatus === "Converted") return "none";
  if (ctx.leadStatus === "Qualified") return "scheduler";
  if (ctx.leadStatus === "Contacted") return "follow_up";
  return "concierge";
}
