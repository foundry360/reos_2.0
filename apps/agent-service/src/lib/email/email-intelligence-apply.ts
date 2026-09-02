import { applyToolCalls } from "@/lib/apply-tools";
import { logSystemContactActivity } from "@/lib/crm/log-system-activity";
import type { EmailIntelligence } from "@/lib/email/email-intelligence";

function pickContactUpdates(
  intelligence: EmailIntelligence,
): Record<string, unknown> {
  const updates = intelligence.contactUpdates;
  if (!updates || typeof updates !== "object") return {};
  return { ...updates };
}

function mergeSuggestedAction(
  intelligence: EmailIntelligence,
  updates: Record<string, unknown>,
): Record<string, unknown> {
  const action = intelligence.suggestedAction;
  if (!action) return updates;

  if (action.type === "schedule_consultation") {
    if (updates.ready_to_book === undefined) updates.ready_to_book = true;
    if (!updates.recommended_next_action) {
      updates.recommended_next_action = action.label;
    }
  }

  if (action.type === "create_calendar_event") {
    if (updates.ready_to_book === undefined) updates.ready_to_book = true;
    if (!updates.recommended_next_action) {
      updates.recommended_next_action =
        intelligence.detectedAppointment ?? action.label;
    }
  }

  return updates;
}

function activitySummary(intelligence: EmailIntelligence): string {
  const parts: string[] = [];
  if (intelligence.intent) parts.push(`Intent: ${intelligence.intent}`);
  if (intelligence.leadSignal?.label) {
    parts.push(`Signal: ${intelligence.leadSignal.label}`);
  } else if (intelligence.opportunitySignal?.label) {
    parts.push(`Signal: ${intelligence.opportunitySignal.label}`);
  }
  if (intelligence.suggestedAction?.label) {
    parts.push(`Action: ${intelligence.suggestedAction.label}`);
  }
  return parts.join(" · ");
}

/** Apply analyzed signals to CRM contact fields and pipeline. */
export async function applyEmailIntelligence(params: {
  tenantId: string;
  contactId: string;
  opportunityId?: string | null;
  emailSubject: string;
  intelligence: EmailIntelligence;
}): Promise<string | null> {
  const { tenantId, contactId, opportunityId, emailSubject, intelligence } = params;
  if (intelligence.status !== "analyzed") return contactId;

  let updates = pickContactUpdates(intelligence);
  updates = mergeSuggestedAction(intelligence, updates);

  const hasUpdates = Object.keys(updates).length > 0;
  let survivorId = contactId;

  if (hasUpdates) {
    survivorId =
      (await applyToolCalls(contactId, [
        { name: "update_contact", args: updates },
      ])) ?? contactId;
  }

  const summary = activitySummary(intelligence);
  if (summary) {
    await logSystemContactActivity({
      tenantId,
      contactId: survivorId,
      activityType: "email",
      title: `Email signal: ${emailSubject}`,
      body: summary,
      relatedEntityType: opportunityId ? "opportunity" : "contact",
      relatedEntityId: opportunityId ?? survivorId,
    });
  }

  if (intelligence.detectedAppointment) {
    await logSystemContactActivity({
      tenantId,
      contactId: survivorId,
      activityType: "appointment",
      title: "Showing request from email",
      body: intelligence.detectedAppointment,
      relatedEntityType: opportunityId ? "opportunity" : "contact",
      relatedEntityId: opportunityId ?? survivorId,
    });
  }

  return survivorId;
}
