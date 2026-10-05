/**
 * Journey "Notify team": an in-app notification to the lead's assigned agent or
 * to every member, respecting each member's "leads" in-app preference.
 *
 * The step succeeds only when at least one notification was created. Nobody to
 * notify is a "config" failure (retrying won't change it); a database failure
 * is "transient" and goes through the normal step retries.
 *
 * Pure module (relative imports only) so it runs under node --test.
 */

import type { NotifyMembersInput, NotifyMembersResult } from "../../notifications/notify-members.ts";
import { renderTemplate, type ActionConfig } from "./contracts.ts";
import { JourneyStepError, type ActionInput, type ActionResult } from "./engine.ts";

export interface NotifyTeamDeps {
  assignedAgentUserId(tenantId: string, contactId: string): Promise<string | null>;
  notify(input: NotifyMembersInput): Promise<NotifyMembersResult>;
}

const NO_RECIPIENTS: Record<
  Extract<ActionConfig, { action: "notify_team" }>["recipients"],
  Record<Extract<NotifyMembersResult, { status: "no_recipients" }>["reason"], string>
> = {
  assigned_agent: {
    no_members: "The lead's assigned agent isn't in this workspace anymore.",
    preferences_off: "The lead's assigned agent has in-app lead notifications turned off.",
  },
  all_members: {
    no_members: "This workspace has no team members to notify.",
    preferences_off: "Every team member has in-app lead notifications turned off.",
  },
};

export async function executeNotifyTeam(
  action: Extract<ActionConfig, { action: "notify_team" }>,
  input: ActionInput,
  deps: NotifyTeamDeps,
): Promise<ActionResult> {
  if (!input.contactId || !input.lead) {
    throw new JourneyStepError("This run isn't linked to a lead in this workspace.", "config");
  }
  const contactId = input.contactId;
  let userIds: string[] | undefined;
  if (action.recipients === "assigned_agent") {
    const agentUserId = await deps.assignedAgentUserId(input.tenantId, contactId);
    if (!agentUserId) throw new JourneyStepError("The lead has no assigned agent to notify.", "config");
    userIds = [agentUserId];
  }

  const names = {
    first_name: typeof input.lead.first_name === "string" ? input.lead.first_name : null,
    last_name: typeof input.lead.last_name === "string" ? input.lead.last_name : null,
  };
  const result = await deps.notify({
    tenantId: input.tenantId,
    userIds,
    category: "leads",
    title: renderTemplate(action.title, names).trim(),
    body: action.body ? renderTemplate(action.body, names).trim() : null,
    href: `/leads/${contactId}`,
  });

  if (result.status === "failed") {
    throw new JourneyStepError(`Couldn't create the notification: ${result.error}`, "transient");
  }
  if (result.status === "no_recipients") {
    throw new JourneyStepError(NO_RECIPIENTS[action.recipients][result.reason], "config");
  }
  return { status: "completed", output: { notified: result.count } };
}
