import { getSupabaseAdmin } from "@/lib/supabase/admin";
import {
  dispatchJourneyEvent,
  type DispatchOutcome,
  type EngineDeps,
  type JourneyEvent,
} from "./engine";
import { createLiveActionExecutor } from "./live-actions";
import { createLiveJourneyAIExecutor } from "./live-ai";
import { createSupabaseJourneyStore } from "./supabase-store";

/** Server-only wiring. The service role never leaves this module's callers (server actions, webhooks, cron). */
export function createLiveEngineDeps(): EngineDeps | null {
  const db = getSupabaseAdmin();
  if (!db) return null;
  return {
    store: createSupabaseJourneyStore(db),
    actions: createLiveActionExecutor(db),
    ai: createLiveJourneyAIExecutor(),
  };
}

export async function runJourneyEvent(event: JourneyEvent): Promise<DispatchOutcome[]> {
  const deps = createLiveEngineDeps();
  if (!deps) return [];
  try {
    return await dispatchJourneyEvent(deps, event);
  } catch (error) {
    // Runs that were created stay due (resume_at = start) and the worker retries them.
    console.error("[journeys] dispatch failed:", event.type, error);
    return [];
  }
}