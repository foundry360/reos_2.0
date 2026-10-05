/**
 * Tells apart the two unique rules a journey_runs insert can hit (Postgres
 * 23505, as PostgREST reports it: the constraint name in `message`, the key
 * columns in `details`).
 *
 *   idempotency: unique (tenant_id, idempotency_key), migration 054. This event
 *                already started this journey.
 *   active_run:  journey_runs_one_active_per_contact_idx, migration 056. The
 *                contact already has a running, waiting, or paused run of it.
 *
 * Pure module (no imports) so it runs under node --test.
 */

export const ACTIVE_RUN_INDEX = "journey_runs_one_active_per_contact_idx";
export const IDEMPOTENCY_CONSTRAINT = "journey_runs_tenant_id_idempotency_key_key";

export type RunInsertConflict = "idempotency" | "active_run";

export function runInsertConflict(
  error: { code?: string | null; message?: string | null; details?: string | null } | null | undefined,
): RunInsertConflict | null {
  if (error?.code !== "23505") return null;
  const message = error.message ?? "";
  const details = error.details ?? "";
  if (message.includes(`"${ACTIVE_RUN_INDEX}"`) || details.startsWith("Key (tenant_id, journey_id, contact_id)=")) {
    return "active_run";
  }
  if (message.includes(`"${IDEMPOTENCY_CONSTRAINT}"`) || details.startsWith("Key (tenant_id, idempotency_key)=")) {
    return "idempotency";
  }
  return null;
}
