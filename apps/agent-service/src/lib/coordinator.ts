/** Agent playbooks — mirrors GHL Concierge / Scheduler / Follow-Up routing. */
export type AgentPlaybook = "concierge" | "scheduler" | "follow_up" | "none";

/** Salesforce Lead_Status__c picklist values. */
export type LeadStatus =
  | "Qualifying"
  | "Ready_to_Book"
  | "Nurture"
  | "Booked"
  | "Handoff"
  | "Compliance";

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
  if (ctx.optedOut || ctx.leadStatus === "Compliance") return "none";
  if (ctx.leadStatus === "Handoff") return "none";
  if (ctx.leadStatus === "Ready_to_Book") return "scheduler";
  if (ctx.leadStatus === "Booked") return "follow_up";
  if (ctx.leadStatus === "Nurture") return "follow_up";
  return "concierge";
}
