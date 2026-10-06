import { after } from "next/server";
import type { OutboxDispatchOptions, OutboxDispatchSummary } from "./runtime/lead-status-outbox";

/**
 * Delivers pending journey_events (migrations 060 and 061) to journeys. The cron tick drains
 * everything due; producers that just wrote an event ask for that contact's rows
 * to go out right away.
 *
 * Imports are lazy so producers don't pull the journey engine into their module graph.
 */
export async function drainJourneyEventOutbox(
  options: Partial<OutboxDispatchOptions> = {},
): Promise<OutboxDispatchSummary | null> {
  const [{ getSupabaseAdmin }, { createLiveEngineDeps }, { dispatchJourneyEvent }, statusOutbox, outboxModule] =
    await Promise.all([
      import("@/lib/supabase/admin"),
      import("./runtime/runtime"),
      import("./runtime/engine"),
      import("./runtime/lead-status-outbox"),
      import("./runtime/journey-event-outbox"),
    ]);
  const db = getSupabaseAdmin();
  const deps = createLiveEngineDeps();
  if (!db || !deps) return null;
  return outboxModule.dispatchJourneyEvents(
    outboxModule.createSupabaseJourneyEventOutbox(db),
    (event) => dispatchJourneyEvent(deps, event),
    { ...statusOutbox.DEFAULT_OUTBOX_OPTIONS, ...options },
  );
}

/** Delivers this contact's pending journey events after the response. Never throws; the cron tick retries anything left. */
export function dispatchJourneyEventsSoon(tenantId: string, contactId: string): void {
  const run = async () => {
    try {
      await drainJourneyEventOutbox({ tenantId, contactId, limit: 10, maxBatches: 1 });
    } catch (error) {
      console.error("[journeys] journey event dispatch failed:", error);
    }
  };
  try {
    after(run);
  } catch {
    void run();
  }
}
