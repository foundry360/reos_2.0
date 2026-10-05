/**
 * Delivers lead_status_events outbox rows (written by the contacts trigger) to
 * journeys as lead.status_changed, through the normal dispatchJourneyEvent.
 *
 * The row id is the event's sourceId, so the run idempotency key
 * (type:sourceId:journeyId:vN) is stable: delivering a row twice (retry, two
 * dispatchers, expired claim) never starts a second run for the same journey.
 *
 * A change made by a journey (origin "journey") goes to every eligible journey
 * except the one whose run made it, found through journey_runs by origin_run_id.
 *
 * Pure module (relative imports only) so it runs under node --test.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import type { JourneyEvent } from "./engine.ts";

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

export interface LeadStatusOutbox {
  claim(options: ClaimOptions): Promise<LeadStatusEventRow[]>;
  complete(row: LeadStatusEventRow): Promise<void>;
  fail(row: LeadStatusEventRow, error: string): Promise<void>;
  /** Journey of the run in this row's workspace with id origin_run_id; null if there is none. */
  originJourneyId(row: LeadStatusEventRow): Promise<string | null>;
}

/** `originJourneyId` is excluded from dispatch: a journey never re-enrolls from its own status change. */
export function leadStatusJourneyEvent(row: LeadStatusEventRow, originJourneyId: string | null = null): JourneyEvent {
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
    },
    ...(originJourneyId ? { excludeJourneyId: originJourneyId } : {}),
  };
}

export interface OutboxDispatchSummary {
  claimed: number;
  delivered: number;
  failed: number;
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
 * stays pending; other rows still run. Throws only if claiming itself fails.
 */
export async function dispatchLeadStatusEvents(
  outbox: LeadStatusOutbox,
  dispatch: (event: JourneyEvent) => Promise<unknown>,
  options: OutboxDispatchOptions = DEFAULT_OUTBOX_OPTIONS,
  clock: () => number = Date.now,
): Promise<OutboxDispatchSummary> {
  const started = clock();
  const summary: OutboxDispatchSummary = { claimed: 0, delivered: 0, failed: 0 };

  for (let batch = 0; batch < options.maxBatches; batch++) {
    if (clock() - started >= options.budgetMs) break;
    const rows = await outbox.claim(options);
    // Claim order isn't guaranteed by UPDATE ... RETURNING; a contact's transitions go out in order.
    rows.sort((a, b) => a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id));
    summary.claimed += rows.length;

    for (const row of rows) {
      try {
        const originJourneyId =
          row.origin === "journey" && row.origin_run_id ? await outbox.originJourneyId(row) : null;
        await dispatch(leadStatusJourneyEvent(row, originJourneyId));
      } catch (error) {
        summary.failed++;
        await outbox.fail(row, errorMessage(error)).catch(() => undefined);
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

/** Outbox backed by the claim/complete/fail functions in migration 055 (service role only). */
export function createSupabaseLeadStatusOutbox(db: SupabaseClient): LeadStatusOutbox {
  return {
    async claim(options) {
      const { data, error } = await db.rpc("claim_lead_status_events", {
        p_limit: options.limit,
        p_lease_seconds: options.leaseSeconds,
        p_tenant_id: options.tenantId ?? null,
        p_contact_id: options.contactId ?? null,
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
      const { error } = await db.rpc("fail_lead_status_event", {
        p_id: row.id,
        p_claim_token: row.claim_token,
        p_error: message,
      });
      if (error) throw new Error(`fail_lead_status_event: ${error.message}`);
    },
    async originJourneyId(row) {
      if (!row.origin_run_id) return null;
      const { data, error } = await db
        .from("journey_runs")
        .select("journey_id")
        .eq("id", row.origin_run_id)
        .eq("tenant_id", row.tenant_id);
      if (error) throw new Error(`origin run lookup: ${error.message}`);
      const journeyId = (data?.[0] as { journey_id?: unknown } | undefined)?.journey_id;
      return typeof journeyId === "string" ? journeyId : null;
    },
  };
}
