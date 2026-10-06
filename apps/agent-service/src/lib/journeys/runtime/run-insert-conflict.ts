/**
 * Tells apart the unique rules a journey_runs insert can hit (Postgres 23505,
 * as PostgREST reports it: the constraint name in `message`, the key columns
 * in `details`), and defines the active-run scope those rules enforce.
 *
 *   idempotency: unique (tenant_id, idempotency_key), migration 054. This event
 *                already started this journey.
 *   active_run:  one active (running, waiting, paused) run per scope, migration
 *                063 (056 before it):
 *                  journey_runs_one_active_per_contact_scope_idx: contact-scoped
 *                    runs, (tenant_id, journey_id, contact_id).
 *                  journey_runs_one_active_per_appointment_idx: appointment-
 *                    scoped runs, (tenant_id, journey_id, entity_id).
 *   ai_step_child: journey_runs_one_child_per_ai_step_idx, migration 059. The
 *                AI step that asked for this run already has a child.
 *
 * Pure module (no imports) so it runs under node --test.
 */

/** Migration 056's contact-wide index; still recognized until 063 is applied. */
export const LEGACY_ACTIVE_RUN_INDEX = "journey_runs_one_active_per_contact_idx";
export const CONTACT_ACTIVE_RUN_INDEX = "journey_runs_one_active_per_contact_scope_idx";
export const APPOINTMENT_ACTIVE_RUN_INDEX = "journey_runs_one_active_per_appointment_idx";
export const IDEMPOTENCY_CONSTRAINT = "journey_runs_tenant_id_idempotency_key_key";
export const AI_STEP_CHILD_INDEX = "journey_runs_one_child_per_ai_step_idx";

export type RunInsertConflict = "idempotency" | "active_run" | "ai_step_child";

const ACTIVE_RUN_INDEXES = [LEGACY_ACTIVE_RUN_INDEX, CONTACT_ACTIVE_RUN_INDEX, APPOINTMENT_ACTIVE_RUN_INDEX];

export function runInsertConflict(
  error: { code?: string | null; message?: string | null; details?: string | null } | null | undefined,
): RunInsertConflict | null {
  if (error?.code !== "23505") return null;
  const message = error.message ?? "";
  const details = error.details ?? "";
  if (
    ACTIVE_RUN_INDEXES.some((index) => message.includes(`"${index}"`)) ||
    details.startsWith("Key (tenant_id, journey_id, contact_id)=") ||
    details.startsWith("Key (tenant_id, journey_id, entity_id)=")
  ) {
    return "active_run";
  }
  if (message.includes(`"${AI_STEP_CHILD_INDEX}"`)) return "ai_step_child";
  if (message.includes(`"${IDEMPOTENCY_CONSTRAINT}"`) || details.startsWith("Key (tenant_id, idempotency_key)=")) {
    return "idempotency";
  }
  return null;
}

/**
 * Which active runs a run (or a run about to be created) competes with. Decided
 * by the event that creates the run, not by the journey's trigger list: an
 * appointment event's run is scoped to that appointment; every other run
 * (manual, journey.started, AI starts, contact/message/task events) to the
 * contact. A run with neither has no active-run limit.
 */
export type RunScope =
  | { kind: "appointment"; appointmentId: string }
  | { kind: "contact"; contactId: string };

export function runScopeOf(run: {
  contactId: string | null | undefined;
  entityType?: string | null;
  entityId?: string | null;
}): RunScope | null {
  if (run.entityType === "appointment" && run.entityId) return { kind: "appointment", appointmentId: run.entityId };
  return run.contactId ? { kind: "contact", contactId: run.contactId } : null;
}

/** True when `run` is in `scope`; the predicates of migration 063's two indexes. */
export function inRunScope(
  run: { contactId: string | null | undefined; entityType?: string | null; entityId?: string | null },
  scope: RunScope,
): boolean {
  if (scope.kind === "appointment") return run.entityType === "appointment" && run.entityId === scope.appointmentId;
  return run.entityType !== "appointment" && run.contactId === scope.contactId;
}
