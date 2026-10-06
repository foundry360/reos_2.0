import type { SupabaseClient } from "@supabase/supabase-js";
import { resolveAgentRecipient, resolveAssignedAgentUserId } from "@/lib/calendar/appointment-invites";
import { logSystemContactActivity } from "@/lib/crm/log-system-activity";
import { withStatusOrigin } from "@/lib/crm/status-origin";
import { isValidEmailAddress } from "@/lib/email/email-utils";
import { recordOutboundEmail } from "@/lib/email/record-outbound-email";
import { sendResendMessage } from "@/lib/email/resend";
import { deliverMessageToContact } from "@/lib/messaging/deliver-message";
import { notifyMembers } from "@/lib/notifications/notify-members";
import { renderTemplate, type ActionConfig } from "./contracts";
import { JourneyStepError, type ActionExecutor, type ActionInput, type ActionResult } from "./engine";
import { executeNotifyTeam } from "./notify-team";
import { executeSendMessage, suppressedSend } from "./send-message";
import { executeUpdateLead, type LeadUpdateStore } from "./update-lead";

function requireContact(input: ActionInput): { contactId: string; lead: Record<string, unknown> } {
  if (!input.contactId || !input.lead) {
    throw new JourneyStepError("This run isn't linked to a lead in this workspace.", "config");
  }
  return { contactId: input.contactId, lead: input.lead };
}

function names(lead: Record<string, unknown> | null) {
  return {
    first_name: typeof lead?.first_name === "string" ? lead.first_name : null,
    last_name: typeof lead?.last_name === "string" ? lead.last_name : null,
  };
}

function escapeHtml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/** Plain-text email body → safe HTML paragraphs. User text is never treated as markup. */
function textToHtml(text: string): string {
  return text
    .trim()
    .split(/\n{2,}/)
    .map((paragraph) => `<p>${escapeHtml(paragraph).replace(/\n/g, "<br/>")}</p>`)
    .join("\n");
}

const JOURNEY_LABEL = "Journey";

function createLeadUpdateStore(db: SupabaseClient): LeadUpdateStore {
  return {
    async updateFields(tenantId, contactId, patch, runId) {
      const { data, error } = await withStatusOrigin(
        db.from("contacts").update(patch).eq("id", contactId).eq("tenant_id", tenantId).select("id"),
        { origin: "journey", originRunId: runId },
      );
      return { error: error?.message ?? null, matched: (data?.length ?? 0) > 0 };
    },
    async convertLeadToClient(tenantId, contactId, contactType) {
      const { data, error } = await db
        .from("contacts")
        .update({ record_type: "contact", contact_type: contactType })
        .eq("id", contactId)
        .eq("tenant_id", tenantId)
        .eq("record_type", "lead")
        .select("id");
      return { error: error?.message ?? null, matched: (data?.length ?? 0) > 0 };
    },
    async logActivity(tenantId, contactId, body) {
      await logSystemContactActivity({ tenantId, contactId, activityType: "contact", title: "Lead updated", body });
    },
  };
}

/** Journey actions backed by the same services the CRM UI and lead agent use. */
export function createLiveActionExecutor(db: SupabaseClient): ActionExecutor {
  const leadUpdates = createLeadUpdateStore(db);
  return {
    async execute(action: Exclude<ActionConfig, { action: "wait" }>, input: ActionInput): Promise<ActionResult> {
      switch (action.action) {
        case "send_sms": {
          const { contactId, lead } = requireContact(input);
          const body = renderTemplate(action.body, names(lead)).trim();
          const sent = await deliverMessageToContact(db, {
            tenantId: input.tenantId,
            contactId,
            channel: "sms",
            body,
            automated: true,
          });
          if (!sent.ok && sent.suppressed) return suppressedSend("sms", sent.suppressed);
          if (!sent.ok) throw new JourneyStepError(sent.error, sent.kind);
          return { status: "completed", output: { message_id: sent.messageId, channel: "sms", body } };
        }

        case "send_messenger":
        case "send_instagram":
          return executeSendMessage(
            action.action === "send_messenger" ? "messenger" : "instagram",
            action,
            input,
            (message) => deliverMessageToContact(db, message),
          );

        case "send_email": {
          const { contactId, lead } = requireContact(input);
          // Read now rather than from the run's loaded lead, which can predate a Wait.
          // There is no email unsubscribe; only handoff stops a journey email.
          const { data: current, error: currentError } = await db
            .from("contacts")
            .select("handoff")
            .eq("id", contactId)
            .eq("tenant_id", input.tenantId)
            .maybeSingle();
          if (currentError) throw new JourneyStepError(currentError.message, "transient");
          if (!current) throw new JourneyStepError("This run isn't linked to a lead in this workspace.", "config");
          if (current.handoff) return suppressedSend("email", "handoff");
          const to = typeof lead.email === "string" ? lead.email.trim().toLowerCase() : "";
          if (!to || !isValidEmailAddress(to)) {
            throw new JourneyStepError("The lead has no valid email address.", "config");
          }
          const agentUserId = await resolveAssignedAgentUserId({
            tenantId: input.tenantId,
            contactId,
            opportunityId: (input.opportunity?.id as string | undefined) ?? null,
          });
          const agent = agentUserId ? await resolveAgentRecipient(agentUserId) : null;
          if (!agent) {
            throw new JourneyStepError("No agent with an email address is available to send from.", "config");
          }
          const subject = renderTemplate(action.subject, names(lead)).trim();
          const bodyHtml = textToHtml(renderTemplate(action.body, names(lead)));
          const recipient = { email: to, name: [names(lead).first_name, names(lead).last_name].filter(Boolean).join(" ") || null };
          const sent = await sendResendMessage({
            to: [recipient],
            cc: [],
            subject,
            bodyHtml,
            replyTo: agent.email,
            agentName: agent.name || "Agent",
          });
          if (!sent.ok) {
            const kind = /not configured/i.test(sent.error) ? "config" : "transient";
            throw new JourneyStepError(sent.error, kind);
          }
          const emailId = await recordOutboundEmail({
            tenantId: input.tenantId,
            userId: null,
            contactId,
            opportunityId: (input.opportunity?.id as string | undefined) ?? null,
            to: [recipient],
            cc: [],
            subject,
            bodyHtml,
            replyTo: agent.email,
            sent,
            metadata: { journey_run_id: input.runId },
          });
          return { status: "completed", output: { email_id: emailId, to, subject } };
        }

        case "assign_lead": {
          const { contactId } = requireContact(input);
          const { data: member } = await db
            .from("memberships")
            .select("user_id")
            .eq("tenant_id", input.tenantId)
            .eq("user_id", action.agentUserId)
            .maybeSingle();
          if (!member) {
            throw new JourneyStepError("That team member isn't in this workspace anymore.", "config");
          }
          // lead.assigned records this run as its origin, so its journey isn't re-enrolled (migration 061).
          const { error } = await withStatusOrigin(
            db
              .from("contacts")
              .update({ assigned_agent_id: action.agentUserId })
              .eq("id", contactId)
              .eq("tenant_id", input.tenantId),
            { origin: "journey", originRunId: input.runId },
          );
          if (error) throw new JourneyStepError(error.message, "transient");
          await db
            .from("opportunities")
            .update({ assigned_agent_id: action.agentUserId })
            .eq("tenant_id", input.tenantId)
            .eq("contact_id", contactId)
            .is("assigned_agent_id", null);
          await logSystemContactActivity({
            tenantId: input.tenantId,
            contactId,
            activityType: "contact",
            title: "Assigned agent updated",
            body: `${JOURNEY_LABEL} assigned this lead.`,
          });
          return { status: "completed", output: { assigned_agent_id: action.agentUserId } };
        }

        case "create_task": {
          const { contactId, lead } = requireContact(input);
          const dueAt =
            action.dueInDays === null
              ? null
              : new Date(Date.now() + action.dueInDays * 24 * 60 * 60_000).toISOString();
          const { data, error } = await db
            .from("tasks")
            .insert({
              tenant_id: input.tenantId,
              contact_id: contactId,
              opportunity_id: (input.opportunity?.id as string | undefined) ?? null,
              title: renderTemplate(action.title, names(lead)).trim(),
              notes: action.notes.trim() ? renderTemplate(action.notes, names(lead)).trim() : null,
              status: "open",
              due_at: dueAt,
            })
            .select("id")
            .single();
          if (error || !data) throw new JourneyStepError(error?.message ?? "Could not create the task.", "transient");
          return { status: "completed", output: { task_id: data.id, due_at: dueAt } };
        }

        case "update_lead":
          return executeUpdateLead(action, input, leadUpdates);

        case "notify_team":
          return executeNotifyTeam(action, input, {
            assignedAgentUserId: (tenantId, contactId) => resolveAssignedAgentUserId({ tenantId, contactId }),
            notify: (notification) => notifyMembers(db, notification),
          });

        case "start_journey":
        case "start_journeys":
          throw new JourneyStepError("Start journey steps are run by the journey engine.", "config");
      }
    },
  };
}
