/**
 * Manual enrollment: eligibility checks, then the normal event path.
 *
 * The checks read through lookups the caller scopes to the member's workspace
 * (the signed-in user's RLS client in production). Enrollment itself is a
 * journey-targeted "manual" event handed to the existing dispatcher, so run
 * creation, idempotency, version pinning, and execution are unchanged.
 *
 * Pure module (relative imports only) so it runs under node --test.
 */

import type { JourneyStatus } from "../journey-types.ts";
import type { JourneyEvent } from "./engine.ts";

export interface ManualEnrollmentLookups {
  contactExists(tenantId: string, contactId: string): Promise<boolean>;
  /** The journey's status and current version, or null when it isn't in this workspace. */
  findJourney(tenantId: string, journeyId: string): Promise<{ status: JourneyStatus; version: number } | null>;
  /** Trigger events of that version's snapshot, or null when the snapshot is missing. */
  versionTriggerEvents(tenantId: string, journeyId: string, version: number): Promise<string[] | null>;
  /** Same contract as JourneyRuntimeStore.hasActiveRun; enrollment always asks for the contact scope. */
  hasActiveRun(tenantId: string, journeyId: string, contactId: string | null, appointmentId?: string | null): Promise<boolean>;
}

export type ManualEnrollmentResult =
  | { result: "enrolled" }
  | { result: "already_active" }
  | { result: "invalid_contact" }
  | { result: "invalid_journey"; reason: "not_found" | "not_active" | "no_manual_trigger" };

export interface ManualEnrollmentRequest {
  tenantId: string;
  userId: string;
  journeyId: string;
  contactId: string;
}

export function manualEnrollmentEvent(request: ManualEnrollmentRequest, sourceId: string): JourneyEvent {
  return {
    tenantId: request.tenantId,
    type: "manual",
    journeyId: request.journeyId,
    // Unique per request, so a finished run can be enrolled again later.
    sourceId,
    contactId: request.contactId,
    entityType: "contact",
    entityId: request.contactId,
    payload: { enrolled_by: request.userId },
  };
}

/**
 * Checks eligibility and, only if everything passes, emits the targeted event.
 * The dispatcher re-checks active runs when it creates the run; the check here
 * lets the caller report "already active" instead of silently doing nothing.
 */
export async function enrollContactInJourney(
  lookups: ManualEnrollmentLookups,
  emit: (event: JourneyEvent) => void | Promise<void>,
  request: ManualEnrollmentRequest,
  newSourceId: () => string,
): Promise<ManualEnrollmentResult> {
  const { tenantId, journeyId, contactId } = request;
  if (!(await lookups.contactExists(tenantId, contactId))) return { result: "invalid_contact" };

  const journey = await lookups.findJourney(tenantId, journeyId);
  if (!journey) return { result: "invalid_journey", reason: "not_found" };
  if (journey.status !== "active") return { result: "invalid_journey", reason: "not_active" };

  const events = await lookups.versionTriggerEvents(tenantId, journeyId, journey.version);
  if (!events?.includes("manual")) return { result: "invalid_journey", reason: "no_manual_trigger" };

  if (await lookups.hasActiveRun(tenantId, journeyId, contactId)) return { result: "already_active" };

  await emit(manualEnrollmentEvent(request, newSourceId()));
  return { result: "enrolled" };
}
