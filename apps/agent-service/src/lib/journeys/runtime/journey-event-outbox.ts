/**
 * Delivers journey_events outbox rows (written by the triggers in migrations
 * 060 and 061) to journeys through the normal dispatchJourneyEvent.
 *
 * The row's source_id is the event's sourceId, so run idempotency keys are the
 * same as for any other event of that type (type:sourceId:journeyId, with no
 * journey version; see idempotencyKey). Delivering a row again (retry, two
 * dispatchers, expired claim) finds the run it already started by that key and
 * starts nothing new.
 *
 * Claim, complete, and fail follow lead_status_events exactly: attempts are
 * counted at claim, failures back off 1, 2, 4 ... 60 minutes, and a row that
 * used its last attempt is parked with failed_at.
 *
 * lead.assigned and lead.handoff_requested can be caused by a journey step
 * (Assign lead, Update lead), so they carry lineage exactly like
 * lead.status_changed (lead-status-outbox.ts): the row's origin and
 * origin_run_id come from the trigger; causation depth, origin journey, and root
 * run are derived here from the originating run in the same workspace; the
 * originating journey is excluded; an event at the depth limit starts no runs
 * and is still marked dispatched. Every other type carries no lineage.
 *
 * Pure module (relative imports only) so it runs under node --test.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import type { TriggerEventType } from "./contracts.ts";
import { isCausationDepthLimited, MAX_JOURNEY_CAUSATION_DEPTH, type JourneyEvent } from "./engine.ts";
import {
  eventCausationDepth,
  leadStatusLineage,
  loadOriginRun,
  type ClaimOptions,
  type FailOutcome,
  type OriginRun,
  type OutboxDispatchOptions,
  type OutboxDispatchSummary,
} from "./lead-status-outbox.ts";

export const JOURNEY_EVENT_TYPES = [
  "lead.created",
  "message.received",
  "appointment.booked",
  "task.completed",
  "opportunity.stage_changed",
  "appointment.rescheduled",
  "lead.assigned",
  "lead.handoff_requested",
  "appointment.cancelled",
  "appointment.completed",
  "appointment.no_show",
] as const satisfies readonly TriggerEventType[];

export type DurableJourneyEventType = (typeof JOURNEY_EVENT_TYPES)[number];

/** Events a journey step can cause; dispatched with lead.status_changed's lineage rules. */
export const LINEAGE_EVENT_TYPES: ReadonlySet<string> = new Set<DurableJourneyEventType>(["lead.assigned", "lead.handoff_requested"]);

export interface JourneyEventRow {
  id: string;
  tenant_id: string;
  contact_id: string;
  event_type: DurableJourneyEventType;
  source_id: string;
  entity_type: string;
  entity_id: string | null;
  payload: Record<string, unknown> | null;
  /** Set by the 061 triggers; null on 060 events and appointment.rescheduled. */
  origin?: string | null;
  /** Only on lead.assigned / lead.handoff_requested with origin "journey". */
  origin_run_id?: string | null;
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
  /** The run in this row's workspace with id origin_run_id; null if there is none. */
  originRun(row: JourneyEventRow): Promise<OriginRun | null>;
}

function provenance(row: JourneyEventRow) {
  return { origin: row.origin ?? "system", origin_run_id: row.origin_run_id ?? null };
}

function rowPayload(row: JourneyEventRow): Record<string, unknown> {
  return row.payload && typeof row.payload === "object" && !Array.isArray(row.payload) ? row.payload : {};
}

export function journeyEventFromRow(row: JourneyEventRow, originRun: OriginRun | null = null): JourneyEvent {
  const event: JourneyEvent = {
    tenantId: row.tenant_id,
    type: row.event_type,
    sourceId: row.source_id,
    contactId: row.contact_id,
    entityType: row.entity_type,
    entityId: row.entity_id,
    payload: rowPayload(row),
  };
  if (!LINEAGE_EVENT_TYPES.has(row.event_type)) return event;

  const source = provenance(row);
  const resolved = source.origin === "journey" ? originRun : null;
  // Lineage keys are only ever the derived values, never anything stored in the row's payload.
  const { origin_journey_id: _journey, root_run_id: _root, causation_depth: _depth, ...stored } = event.payload;
  return {
    ...event,
    payload: {
      ...stored,
      origin: source.origin,
      origin_run_id: source.origin_run_id,
      causation_depth: eventCausationDepth(source, resolved),
      ...leadStatusLineage(source, resolved),
    },
    ...(resolved ? { excludeJourneyId: resolved.journeyId } : {}),
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
      let depthLimited = false;
      try {
        const lineage = LINEAGE_EVENT_TYPES.has(row.event_type);
        const originRun = lineage && row.origin === "journey" && row.origin_run_id ? await outbox.originRun(row) : null;
        const event = journeyEventFromRow(row, originRun);
        const depth = lineage ? (event.payload.causation_depth as number) : 0;
        if (lineage && isCausationDepthLimited(depth)) {
          depthLimited = true;
          log(
            `[journeys] ${row.event_type} event ${row.id} started no journeys: causation depth ${depth} reached the limit of ${MAX_JOURNEY_CAUSATION_DEPTH} (origin run ${row.origin_run_id}).`,
          );
        } else {
          await dispatch(event);
        }
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
      if (depthLimited) summary.depthLimited++;
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
    originRun: (row) => loadOriginRun(db, row.tenant_id, row.origin_run_id ?? null),
  };
}
