import { after } from "next/server";
import type { OutboxDispatchOptions, OutboxDispatchSummary } from "./runtime/lead-status-outbox";

/**
 * Delivers pending lead status changes (lead_status_events) to journeys. The
 * cron tick drains everything due; callers that just changed a status can ask
 * for that contact's rows to go out right away.
 *
 * Imports are lazy so producers don't pull the journey engine into their module graph.
 */
export async function drainLeadStatusOutbox(
  options: Partial<OutboxDispatchOptions> = {},
): Promise<OutboxDispatchSummary | null> {
  const [{ getSupabaseAdmin }, { createLiveEngineDeps }, { dispatchJourneyEvent }, outboxModule] = await Promise.all([
    import("@/lib/supabase/admin"),
    import("./runtime/runtime"),
    import("./runtime/engine"),
    import("./runtime/lead-status-outbox"),
  ]);
  const db = getSupabaseAdmin();
  const deps = createLiveEngineDeps();
  if (!db || !deps) return null;
  return outboxModule.dispatchLeadStatusEvents(
    outboxModule.createSupabaseLeadStatusOutbox(db),
    (event) => dispatchJourneyEvent(deps, event),
    { ...outboxModule.DEFAULT_OUTBOX_OPTIONS, ...options },
  );
}

/** Delivers this contact's pending status changes after the response. Never throws; the cron tick retries anything left. */
export function dispatchLeadStatusEventsSoon(tenantId: string, contactId: string): void {
  const run = async () => {
    try {
      await drainLeadStatusOutbox({ tenantId, contactId, limit: 10, maxBatches: 1 });
    } catch (error) {
      console.error("[journeys] lead status dispatch failed:", error);
    }
  };
  try {
    after(run);
  } catch {
    void run();
  }
}
