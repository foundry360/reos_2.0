/**
 * Journey "Update lead": writes exactly the fields the action configured.
 *
 * Unlike the lead agent's applyToolCalls, nothing is implied: no status is
 * inferred from intent or ready-to-book, no summary/score rebuild, no
 * opportunity sync. The one consequence kept is the CRM's own rule from
 * updateLeadStatusAction: an explicit "Converted" status turns a lead into a
 * client with the default client type. Records that are already clients keep
 * their client type.
 *
 * A status change is recorded by the contacts trigger with origin "journey" and
 * this run's id, and dispatched to other journeys, never back to this run's
 * journey (see lead-status-outbox.ts).
 *
 * Pure module (relative imports only) so it runs under node --test.
 */

import { DEFAULT_CONTACT_TYPE } from "../../crm/contact-type.ts";
import { UPDATE_LEAD_FIELDS, type ActionConfig, type UpdateLeadField } from "./contracts.ts";
import { JourneyStepError, type ActionInput, type ActionResult } from "./engine.ts";

export type LeadFieldPatch = Partial<Record<UpdateLeadField, string | number | boolean>>;

export interface LeadWriteResult {
  error: string | null;
  /** False when no row in the workspace matched. */
  matched: boolean;
}

/** Workspace-scoped writes used by the Update lead action. */
export interface LeadUpdateStore {
  /** `runId` is recorded as the origin of any status change this write makes. */
  updateFields(tenantId: string, contactId: string, patch: LeadFieldPatch, runId: string): Promise<LeadWriteResult>;
  /** Only flips records that are still leads. */
  convertLeadToClient(tenantId: string, contactId: string, contactType: string): Promise<LeadWriteResult>;
  logActivity(tenantId: string, contactId: string, body: string): Promise<void>;
}

/** The configured fields only; unknown keys and empty values are dropped. */
export function leadFieldPatch(fields: Record<string, unknown>): LeadFieldPatch {
  const patch: LeadFieldPatch = {};
  for (const key of Object.keys(UPDATE_LEAD_FIELDS) as UpdateLeadField[]) {
    if (!Object.hasOwn(fields, key)) continue;
    const value = fields[key];
    if (typeof value === "string") {
      const trimmed = value.trim();
      if (trimmed) patch[key] = trimmed;
    } else if (typeof value === "boolean" || (typeof value === "number" && Number.isFinite(value))) {
      patch[key] = value;
    }
  }
  return patch;
}

export async function executeUpdateLead(
  action: Extract<ActionConfig, { action: "update_lead" }>,
  input: ActionInput,
  store: LeadUpdateStore,
): Promise<ActionResult> {
  if (!input.contactId || !input.lead) {
    throw new JourneyStepError("This run isn't linked to a lead in this workspace.", "config");
  }
  const contactId = input.contactId;
  const patch = leadFieldPatch(action.fields);
  const keys = Object.keys(patch) as UpdateLeadField[];
  if (keys.length === 0) {
    return { status: "skipped", output: {}, reason: "No fields to update." };
  }

  const written = await store.updateFields(input.tenantId, contactId, patch, input.runId);
  if (written.error) throw new JourneyStepError(written.error, "transient");
  if (!written.matched) throw new JourneyStepError("This lead no longer exists in this workspace.", "config");

  let converted = false;
  if (patch.lead_status === "Converted") {
    const conversion = await store.convertLeadToClient(input.tenantId, contactId, DEFAULT_CONTACT_TYPE);
    if (conversion.error) throw new JourneyStepError(conversion.error, "transient");
    converted = conversion.matched;
  }

  const labels = keys.map((key) => UPDATE_LEAD_FIELDS[key].label.toLowerCase()).join(", ");
  await store.logActivity(
    input.tenantId,
    contactId,
    `Journey set ${labels}.${converted ? " Converted to client." : ""}`,
  );
  return { status: "completed", output: { updated: keys, converted } };
}
