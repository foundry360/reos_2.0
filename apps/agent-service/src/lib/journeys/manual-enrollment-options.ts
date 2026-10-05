import type { JourneyEnrollmentOutcome } from "./journey-actions.ts";
import type { JourneyStatus } from "./journey-types.ts";

export interface ManualEnrollmentJourneyOption {
  id: string;
  name: string;
  description: string;
  /** The lead has a running, waiting, or paused run in this journey. */
  alreadyActive: boolean;
}

export interface ManualEnrollmentJourneyRow {
  id: string;
  name: string;
  description: string;
  status: JourneyStatus;
  version: number;
}

export interface ManualEnrollmentVersionRow {
  journeyId: string;
  version: number;
  triggerEvents: string[];
}

/**
 * Journeys a lead can be enrolled in by hand: active, and the current version
 * (not an older one) has a Manual enrollment trigger.
 */
export function manualEnrollmentOptions(
  journeys: ManualEnrollmentJourneyRow[],
  versions: ManualEnrollmentVersionRow[],
  activeJourneyIds: Iterable<string>,
): ManualEnrollmentJourneyOption[] {
  const manualVersions = new Set(
    versions
      .filter((row) => row.triggerEvents.includes("manual"))
      .map((row) => `${row.journeyId}:${row.version}`),
  );
  const active = new Set(activeJourneyIds);
  return journeys
    .filter((journey) => journey.status === "active" && manualVersions.has(`${journey.id}:${journey.version}`))
    .map((journey) => ({
      id: journey.id,
      name: journey.name,
      description: journey.description,
      alreadyActive: active.has(journey.id),
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

export type EnrollmentNoticeTone = "success" | "info" | "error";

export interface EnrollmentNotice {
  tone: EnrollmentNoticeTone;
  message: string;
}

const NOTICES: Record<JourneyEnrollmentOutcome, EnrollmentNotice> = {
  enrolled: { tone: "success", message: "Lead enrolled in Journey." },
  already_active: { tone: "info", message: "This lead is already active in this Journey." },
  invalid_journey: { tone: "error", message: "This Journey is no longer available for enrollment." },
  invalid_contact: { tone: "error", message: "This lead is no longer available." },
  unauthorized: { tone: "error", message: "You don't have permission to enroll this lead in a Journey." },
  failed: { tone: "error", message: "Could not enroll the lead. Please try again." },
};

/** Fixed copy per result; server error text is never shown. */
export function enrollmentNotice(result: JourneyEnrollmentOutcome): EnrollmentNotice {
  return NOTICES[result] ?? NOTICES.failed;
}
