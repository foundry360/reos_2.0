import { getSupabaseAdmin } from "@/lib/supabase/admin";
import { createAIStepRouter } from "./ai";
import {
  dispatchJourneyEvent,
  resumeDueRuns,
  type DispatchOutcome,
  type EngineDeps,
  type JourneyEvent,
} from "./engine";
import { createLiveActionExecutor } from "./live-actions";
import { createSupabaseJourneyStore } from "./supabase-store";

/** Server-only wiring. The service role never leaves this module's callers (server actions, webhooks, cron). */
export function createLiveEngineDeps(): EngineDeps | null {
  const db = getSupabaseAdmin();
  if (!db) return null;
  return {
    store: createSupabaseJourneyStore(db),
    actions: createLiveActionExecutor(db),
    // No AI step executors are registered yet; AI nodes record a skipped step.
    ai: createAIStepRouter(),
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

export async function resumeDueJourneyRuns(limit = 25) {
  const deps = createLiveEngineDeps();
  if (!deps) return { processed: 0, outcomes: [] };
  return resumeDueRuns(deps, limit);
}
