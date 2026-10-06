/**
 * Delivers journey_events outbox rows (lead.created, message.received,
 * appointment.booked, task.completed; written by the triggers in migration 060)
 * to journeys through the normal dispatchJourneyEvent.
 *
 * The row's source_id is the event's sourceId, so run idempotency keys are the
 * same as for any other event of that type (type:sourceId:journeyId:vN).
 * Delivering a row again (retry, two dispatchers, expired claim) finds the run
 * it already started by that key and starts nothing new.
 *
 * Claim, complete, and fail follow lead_status_events exactly: attempts are
 * counted at claim, failures back off 1, 2, 4 ... 60 minutes, and a row that
 * used its last attempt is parked with failed_at.
 *
 * Pure module (relative imports only) so it runs under node --test.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import type { TriggerEventType } from "./contracts.ts";
import type { JourneyEvent } from "./engine.ts";
import type {
  ClaimOptions,
  FailOutcome,
  OutboxDispatchOptions,
  OutboxDispatchSummary,
} from "./lead-status-outbox.ts";

export const JOURNEY_EVENT_TYPES = [
  "lead.created",
  "message.received",
  "appointment.booked",
  "task.completed",
] as const satisfies readonly TriggerEventType[];

export type DurableJourneyEventType = (typeof JOURNEY_EVENT_TYPES)[number];

export interface JourneyEventRow {
  id: string;
  tenant_id: string;
  contact_id: string;
  event_type: DurableJourneyEventType;
  source_id: string;
  entity_type: string;
  entity_id: string | null;
  payload: Record<string, unknown> | null;
  created_at: string;
  attempt_count: number;
  claim_token: string | null;
}

/** Same limit as lead status events. */
export const MAX_JOURNEY_EVENT_ATTEMPTS = 10;

export interface JourneyEventOutbox {
  claim(options: ClaimOptions): Promise<JourneyEventRow[]>;
  complete(row: JourneyEventRow): Promise<void>;
  fail(row: JourneyEventRow, error: string): Promise<FailOutcome>;
}

export function journeyEventFromRow(row: JourneyEventRow): JourneyEvent {
  return {
    tenantId: row.tenant_id,
    type: row.event_type,
    sourceId: row.source_id,
    contactId: row.contact_id,
    entityType: row.entity_type,
    entityId: row.entity_id,
    payload: row.payload && typeof row.payload === "object" && !Array.isArray(row.payload) ? row.payload : {},
  };
}

function errorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message || "Unknown error.";
}

/**
 * Claims and delivers pending rows. A failed row is released with backoff and
 * stays pending, unless that was its last attempt (it is then permanently
 * failed); other rows still run. Throws only if claiming itself fails.
 */
export async function dispatchJourneyEvents(
  outbox: JourneyEventOutbox,
  dispatch: (event: JourneyEvent) => Promise<unknown>,
  options: OutboxDispatchOptions,
  clock: () => number = Date.now,
  log: (message: string) => void = (message) => console.log(message),
): Promise<OutboxDispatchSummary> {
  const started = clock();
  const summary: OutboxDispatchSummary = { claimed: 0, delivered: 0, depthLimited: 0, failed: 0, permanentlyFailed: 0 };

  for (let batch = 0; batch < options.maxBatches; batch++) {
    if (clock() - started >= options.budgetMs) break;
    const rows = await outbox.claim(options);
    // Claim order isn't guaranteed by UPDATE ... RETURNING; a contact's events go out in order.
    rows.sort((a, b) => a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id));
    summary.claimed += rows.length;

    for (const row of rows) {
      try {
        await dispatch(journeyEventFromRow(row));
      } catch (error) {
        summary.failed++;
        const message = errorMessage(error);
        const outcome = await outbox.fail(row, message).catch(() => undefined);
        if (outcome === "failed") {
          summary.permanentlyFailed++;
          log(`[journeys] ${row.event_type} event ${row.id} permanently failed after ${row.attempt_count} attempts: ${message}`);
        }
        continue;
      }
      try {
        await outbox.complete(row);
      } catch {
        // Left claimed: once the claim expires the row is delivered again, which the
        // idempotency key turns into a no-op for journeys that already started.
        summary.failed++;
        continue;
      }
      summary.delivered++;
    }

    if (rows.length < options.limit) break;
  }
  return summary;
}

/** Outbox backed by the claim/complete/fail functions in migration 060 (service role only). */
export function createSupabaseJourneyEventOutbox(db: SupabaseClient): JourneyEventOutbox {
  return {
    async claim(options) {
      const { data, error } = await db.rpc("claim_journey_events", {
        p_limit: options.limit,
        p_lease_seconds: options.leaseSeconds,
        p_tenant_id: options.tenantId ?? null,
        p_contact_id: options.contactId ?? null,
        p_max_attempts: MAX_JOURNEY_EVENT_ATTEMPTS,
      });
      if (error) throw new Error(`claim_journey_events: ${error.message}`);
      return (data ?? []) as JourneyEventRow[];
    },
    async complete(row) {
      const { error } = await db.rpc("complete_journey_event", {
        p_id: row.id,
        p_claim_token: row.claim_token,
      });
      if (error) throw new Error(`complete_journey_event: ${error.message}`);
    },
    async fail(row, message) {
      const { data, error } = await db.rpc("fail_journey_event", {
        p_id: row.id,
        p_claim_token: row.claim_token,
        p_error: message,
        p_max_attempts: MAX_JOURNEY_EVENT_ATTEMPTS,
      });
      if (error) throw new Error(`fail_journey_event: ${error.message}`);
      return data === "failed" || data === "retry" ? data : "stale";
    },
  };
}
