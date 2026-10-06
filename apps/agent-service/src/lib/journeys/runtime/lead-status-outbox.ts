/**
 * Delivers lead_status_events outbox rows (written by the contacts trigger) to
 * journeys as lead.status_changed, through the normal dispatchJourneyEvent.
 *
 * The row id is the event's sourceId, and for lead.status_changed the run
 * idempotency key is lead.status_changed:<row id>:<journeyId>, with no journey
 * version (other journey events keep type:sourceId:journeyId:vN). Delivering a
 * row again (retry, two dispatchers, expired claim), even after the journey was
 * saved as a new version, never starts a second run for the same journey.
 *
 * A change made by a journey (origin "journey") goes to every eligible journey
 * except the one whose run made it, found through journey_runs by origin_run_id.
 *
 * Causation depth bounds journey → status change → journey chains. It is read
 * only from the originating run's trigger_payload, which the runtime writes when
 * it creates the run and never changes; requests can't supply it.
 *   event depth 0: the change wasn't made by a journey run (user, AI agent, system, import, merge)
 *   event depth N: the change was made by a run of depth N
 *   run depth: the depth of the journey-caused event (status change or Start
 *     journey) that started it, plus 1 (any other trigger: 1); see runCausationDepth
 * An event at depth MAX_JOURNEY_CAUSATION_DEPTH starts no runs; it is still
 * recorded and marked dispatched.
 *
 * A change made by a run found in the workspace also carries origin_journey_id
 * and root_run_id (see leadStatusLineage); other changes don't have those keys.
 *
 * Pure module (relative imports only) so it runs under node --test.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import {
  isCausationDepthLimited,
  MAX_JOURNEY_CAUSATION_DEPTH,
  runCausationDepth,
  runRootId,
  type JourneyEvent,
} from "./engine.ts";

export interface LeadStatusEventRow {
  id: string;
  tenant_id: string;
  contact_id: string;
  from_status: string | null;
  to_status: string;
  origin: string;
  actor_user_id: string | null;
  origin_run_id: string | null;
  converted: boolean;
  changed_at: string;
  created_at: string;
  attempt_count: number;
  claim_token: string | null;
}

export interface ClaimOptions {
  limit: number;
  leaseSeconds: number;
  tenantId?: string;
  contactId?: string;
}

/** The journey run that made a status change, as stored in journey_runs. */
export interface OriginRun {
  journeyId: string;
  triggerEvent: string;
  triggerPayload: Record<string, unknown>;
}

/**
 * Delivery attempts per row, counted at claim (so a dispatcher that dies
 * mid-delivery still uses one up). A row is never claimed after this many.
 */
export const MAX_LEAD_STATUS_EVENT_ATTEMPTS = 10;

/** "retry": rescheduled with backoff. "failed": that was the last attempt. "stale": the claim was no longer ours. */
export type FailOutcome = "retry" | "failed" | "stale";

export interface LeadStatusOutbox {
  claim(options: ClaimOptions): Promise<LeadStatusEventRow[]>;
  complete(row: LeadStatusEventRow): Promise<void>;
  fail(row: LeadStatusEventRow, error: string): Promise<FailOutcome>;
  /** The run in this row's workspace with id origin_run_id; null if there is none. */
  originRun(row: LeadStatusEventRow): Promise<OriginRun | null>;
}

export { runCausationDepth };

/** The provenance an event row records (lead_status_events, and journey_events from migration 061). */
export type EventProvenance = Pick<LeadStatusEventRow, "origin" | "origin_run_id">;

/** Depth of this status change: 0 unless a journey run in the same workspace made it. */
export function eventCausationDepth(row: Pick<EventProvenance, "origin">, originRun: OriginRun | null): number {
  return row.origin === "journey" && originRun ? runCausationDepth(originRun) : 0;
}

/**
 * Lineage for a change made by a journey run found in the row's workspace:
 * the run's journey, and the first run of the chain (the run's own recorded
 * root, else the run itself). Inherited the same way as depth: only from a run
 * started by a journey-caused event. Observability only; never read for depth,
 * exclusion, or access. Without a resolved origin run there is no lineage.
 */
export function leadStatusLineage(
  row: EventProvenance,
  originRun: OriginRun | null,
): { origin_journey_id: string; root_run_id: string } | null {
  if (row.origin !== "journey" || !originRun || !row.origin_run_id) return null;
  return { origin_journey_id: originRun.journeyId, root_run_id: runRootId(originRun, row.origin_run_id) };
}

/** `originRun`'s journey is excluded from dispatch: a journey never re-enrolls from its own status change. */
export function leadStatusJourneyEvent(row: LeadStatusEventRow, originRun: OriginRun | null = null): JourneyEvent {
  const lineage = leadStatusLineage(row, originRun);
  return {
    tenantId: row.tenant_id,
    type: "lead.status_changed",
    sourceId: row.id,
    contactId: row.contact_id,
    entityType: "contact",
    entityId: row.contact_id,
    payload: {
      event_id: row.id,
      from_status: row.from_status,
      to_status: row.to_status,
      origin: row.origin,
      actor_user_id: row.actor_user_id,
      origin_run_id: row.origin_run_id,
      converted: row.converted,
      changed_at: row.changed_at,
      causation_depth: eventCausationDepth(row, originRun),
      ...lineage,
    },
    ...(row.origin === "journey" && originRun ? { excludeJourneyId: originRun.journeyId } : {}),
  };
}

export interface OutboxDispatchSummary {
  claimed: number;
  delivered: number;
  /** Delivered rows that started no runs because their causation depth reached the limit. */
  depthLimited: number;
  failed: number;
  /** Failed rows that had used their last attempt; they are not retried (failed_at is set). */
  permanentlyFailed: number;
}

export interface OutboxDispatchOptions extends ClaimOptions {
  /** Claim rounds; each round claims up to `limit` rows. */
  maxBatches: number;
  /** No new batch is claimed after this much time. */
  budgetMs: number;
}

export const DEFAULT_OUTBOX_OPTIONS: OutboxDispatchOptions = {
  limit: 25,
  leaseSeconds: 120,
  maxBatches: 4,
  budgetMs: 20_000,
};

function errorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message || "Unknown error.";
}

/**
 * Claims and delivers pending rows. A failed row is released with backoff and
 * stays pending, unless that was its last attempt (it is then permanently
 * failed); other rows still run. Throws only if claiming itself fails.
 */
export async function dispatchLeadStatusEvents(
  outbox: LeadStatusOutbox,
  dispatch: (event: JourneyEvent) => Promise<unknown>,
  options: OutboxDispatchOptions = DEFAULT_OUTBOX_OPTIONS,
  clock: () => number = Date.now,
  log: (message: string) => void = (message) => console.log(message),
): Promise<OutboxDispatchSummary> {
  const started = clock();
  const summary: OutboxDispatchSummary = { claimed: 0, delivered: 0, depthLimited: 0, failed: 0, permanentlyFailed: 0 };

  for (let batch = 0; batch < options.maxBatches; batch++) {
    if (clock() - started >= options.budgetMs) break;
    const rows = await outbox.claim(options);
    // Claim order isn't guaranteed by UPDATE ... RETURNING; a contact's transitions go out in order.
    rows.sort((a, b) => a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id));
    summary.claimed += rows.length;

    for (const row of rows) {
      let depthLimited = false;
      try {
        const originRun = row.origin === "journey" && row.origin_run_id ? await outbox.originRun(row) : null;
        const event = leadStatusJourneyEvent(row, originRun);
        const depth = event.payload.causation_depth as number;
        if (isCausationDepthLimited(depth)) {
          depthLimited = true;
          log(
            `[journeys] lead status event ${row.id} started no journeys: causation depth ${depth} reached the limit of ${MAX_JOURNEY_CAUSATION_DEPTH} (origin run ${row.origin_run_id}).`,
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
          log(`[journeys] lead status event ${row.id} permanently failed after ${row.attempt_count} attempts: ${message}`);
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

/** Outbox backed by the claim/complete/fail functions in migration 055 (service role only). */
export function createSupabaseLeadStatusOutbox(db: SupabaseClient): LeadStatusOutbox {
  return {
    async claim(options) {
      const { data, error } = await db.rpc("claim_lead_status_events", {
        p_limit: options.limit,
        p_lease_seconds: options.leaseSeconds,
        p_tenant_id: options.tenantId ?? null,
        p_contact_id: options.contactId ?? null,
        p_max_attempts: MAX_LEAD_STATUS_EVENT_ATTEMPTS,
      });
      if (error) throw new Error(`claim_lead_status_events: ${error.message}`);
      return (data ?? []) as LeadStatusEventRow[];
    },
    async complete(row) {
      const { error } = await db.rpc("complete_lead_status_event", {
        p_id: row.id,
        p_claim_token: row.claim_token,
      });
      if (error) throw new Error(`complete_lead_status_event: ${error.message}`);
    },
    async fail(row, message) {
      const { data, error } = await db.rpc("fail_lead_status_event", {
        p_id: row.id,
        p_claim_token: row.claim_token,
        p_error: message,
        p_max_attempts: MAX_LEAD_STATUS_EVENT_ATTEMPTS,
      });
      if (error) throw new Error(`fail_lead_status_event: ${error.message}`);
      return data === "failed" || data === "retry" ? data : "stale";
    },
    originRun: (row) => loadOriginRun(db, row.tenant_id, row.origin_run_id),
  };
}

/** The run `originRunId` in `tenantId`'s workspace; null if there is none. */
export async function loadOriginRun(
  db: SupabaseClient,
  tenantId: string,
  originRunId: string | null,
): Promise<OriginRun | null> {
  if (!originRunId) return null;
  const { data, error } = await db
    .from("journey_runs")
    .select("journey_id, trigger_event, trigger_payload")
    .eq("id", originRunId)
    .eq("tenant_id", tenantId);
  if (error) throw new Error(`origin run lookup: ${error.message}`);
  const run = data?.[0] as { journey_id?: unknown; trigger_event?: unknown; trigger_payload?: unknown } | undefined;
  if (!run || typeof run.journey_id !== "string") return null;
  const payload = run.trigger_payload;
  return {
    journeyId: run.journey_id,
    triggerEvent: typeof run.trigger_event === "string" ? run.trigger_event : "",
    triggerPayload: payload && typeof payload === "object" && !Array.isArray(payload) ? (payload as Record<string, unknown>) : {},
  };
}
