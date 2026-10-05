import { createClient } from "@/lib/supabase/server";
import { getSupabaseAdmin } from "@/lib/supabase/admin";
import type { RepositoryResult } from "./journey-repository";
import { isJourneyStatus } from "./journey-types";
import { JOURNEY_ARCHIVED_ERROR, type RunState } from "./runtime/engine";
import type { ManualEnrollmentLookups } from "./runtime/manual-enrollment";
import { RETRY_BLOCK_MESSAGES, retryJourneyRun, type RunRetryLookups } from "./runtime/run-retry";
import { createSupabaseJourneyStore } from "./runtime/supabase-store";

export type JourneyRunStatus = "running" | "waiting" | "completed" | "failed" | "cancelled" | "paused";
export type JourneyStepStatus = "pending" | "running" | "completed" | "failed" | "skipped";

export interface JourneyRunSummary {
  id: string;
  journeyVersion: number;
  status: JourneyRunStatus;
  /** The node the run is at (for a failed run, the node it failed at). */
  currentNodeId: string | null;
  /** Only the runtime state that decides whether a failed run can be retried. */
  context: Pick<RunState, "inFlight" | "waitingStepId">;
  triggerEvent: string;
  contactId: string | null;
  contactName: string | null;
  error: string | null;
  startedAt: string;
  completedAt: string | null;
  resumeAt: string | null;
}

export interface JourneyRunStep {
  id: string;
  nodeId: string;
  nodeType: string;
  nodeName: string;
  status: JourneyStepStatus;
  output: Record<string, unknown>;
  error: string | null;
  errorKind: "transient" | "config" | null;
  attemptCount: number;
  startedAt: string;
  completedAt: string | null;
}

export const ACTIVE_STATUSES: JourneyRunStatus[] = ["running", "waiting", "paused"];

/** Run history is read with the signed-in user's client, so RLS limits it to their workspace. */
export async function listJourneyRuns(
  tenantId: string,
  journeyId: string,
  limit = 50,
): Promise<RepositoryResult<JourneyRunSummary[]>> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("journey_runs")
    .select(
      "id, journey_version, status, current_node_id, in_flight:context->inFlight, waiting_step_id:context->>waitingStepId, trigger_event, contact_id, error, started_at, completed_at, resume_at, contacts(first_name, last_name)",
    )
    .eq("tenant_id", tenantId)
    .eq("journey_id", journeyId)
    .order("started_at", { ascending: false })
    .limit(limit);

  if (error) {
    console.error("listJourneyRuns failed:", error.message);
    return {
      ok: false,
      error: /journey_runs/.test(error.message)
        ? "Run history isn't set up yet. Apply the journey runtime migration."
        : "Could not load run history.",
    };
  }

  return {
    ok: true,
    value: (data ?? []).map((row) => {
      const contact = (Array.isArray(row.contacts) ? row.contacts[0] : row.contacts) as
        | { first_name: string | null; last_name: string | null }
        | null;
      const name = [contact?.first_name, contact?.last_name].filter(Boolean).join(" ").trim();
      return {
        id: row.id,
        journeyVersion: row.journey_version,
        status: row.status as JourneyRunStatus,
        currentNodeId: row.current_node_id,
        context: {
          ...(row.in_flight ? { inFlight: row.in_flight as unknown as RunState["inFlight"] } : {}),
          ...(row.waiting_step_id ? { waitingStepId: row.waiting_step_id as string } : {}),
        },
        triggerEvent: row.trigger_event,
        contactId: row.contact_id,
        contactName: name || null,
        error: row.error,
        startedAt: row.started_at,
        completedAt: row.completed_at,
        resumeAt: row.resume_at,
      };
    }),
  };
}

/** Steps for several runs in one query, grouped by run id. */
export async function listJourneyRunSteps(
  tenantId: string,
  runIds: string[],
): Promise<RepositoryResult<Map<string, JourneyRunStep[]>>> {
  if (runIds.length === 0) return { ok: true, value: new Map() };
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("journey_run_steps")
    .select("id, run_id, node_id, node_type, node_name, status, output, error, error_kind, attempt_count, started_at, completed_at")
    .eq("tenant_id", tenantId)
    .in("run_id", runIds)
    .order("created_at", { ascending: true });

  if (error) {
    console.error("listJourneyRunSteps failed:", error.message);
    return { ok: false, error: "Could not load run steps." };
  }

  const grouped = new Map<string, JourneyRunStep[]>();
  for (const row of data ?? []) {
    const list = grouped.get(row.run_id) ?? [];
    list.push(toStep(row));
    grouped.set(row.run_id, list);
  }
  return { ok: true, value: grouped };
}

function toStep(row: {
  id: string;
  node_id: string;
  node_type: string;
  node_name: string;
  status: string;
  output: unknown;
  error: string | null;
  error_kind: string | null;
  attempt_count: number;
  started_at: string;
  completed_at: string | null;
}): JourneyRunStep {
  return {
    id: row.id,
    nodeId: row.node_id,
    nodeType: row.node_type,
    nodeName: row.node_name,
    status: row.status as JourneyStepStatus,
    output: (row.output as Record<string, unknown>) ?? {},
    error: row.error,
    errorKind: row.error_kind as JourneyRunStep["errorKind"],
    attemptCount: row.attempt_count,
    startedAt: row.started_at,
    completedAt: row.completed_at,
  };
}

/**
 * Members can't write runs directly (select-only RLS). Ownership is checked with
 * the user's client first; only then does the service role apply the change.
 */
export async function cancelJourneyRun(
  tenantId: string,
  runId: string,
): Promise<RepositoryResult<{ journeyId: string }>> {
  const supabase = await createClient();
  const { data: run } = await supabase
    .from("journey_runs")
    .select("id, journey_id, status")
    .eq("tenant_id", tenantId)
    .eq("id", runId)
    .maybeSingle();
  if (!run) return { ok: false, error: "Run not found." };
  if (!ACTIVE_STATUSES.includes(run.status as JourneyRunStatus)) {
    return { ok: false, error: "This run has already finished." };
  }

  const db = getSupabaseAdmin();
  if (!db) return { ok: false, error: "Journey runtime is unavailable." };
  const now = new Date().toISOString();
  const { error } = await db
    .from("journey_runs")
    .update({ status: "cancelled", completed_at: now, resume_at: null, locked_until: null, error: "Cancelled by a team member." })
    .eq("tenant_id", tenantId)
    .eq("id", runId)
    .in("status", ACTIVE_STATUSES);
  if (error) {
    console.error("cancelJourneyRun failed:", error.message);
    return { ok: false, error: "Could not cancel the run." };
  }
  await db
    .from("journey_run_steps")
    .update({ status: "skipped", completed_at: now, error: "Run cancelled." })
    .eq("tenant_id", tenantId)
    .eq("run_id", runId)
    .eq("status", "running");
  return { ok: true, value: { journeyId: run.journey_id } };
}

/**
 * Cancels every active run of a journey (archive), with the same changes as
 * cancelJourneyRun. The caller already verified tenant ownership of the journey.
 * Safe to repeat: finished runs are never touched.
 */
export async function cancelActiveJourneyRuns(
  tenantId: string,
  journeyId: string,
): Promise<RepositoryResult<{ cancelled: number }>> {
  const db = getSupabaseAdmin();
  if (!db) return { ok: false, error: "Journey runtime is unavailable." };
  const now = new Date().toISOString();
  const { data: runs, error } = await db
    .from("journey_runs")
    .update({ status: "cancelled", completed_at: now, resume_at: null, locked_until: null, error: JOURNEY_ARCHIVED_ERROR })
    .eq("tenant_id", tenantId)
    .eq("journey_id", journeyId)
    .in("status", ACTIVE_STATUSES)
    .select("id");
  if (error) {
    console.error("cancelActiveJourneyRuns failed:", error.message);
    return { ok: false, error: "Could not cancel the journey's active runs." };
  }
  const runIds = (runs ?? []).map((run) => run.id as string);
  if (runIds.length > 0) {
    const { error: stepError } = await db
      .from("journey_run_steps")
      .update({ status: "skipped", completed_at: now, error: "Run cancelled." })
      .eq("tenant_id", tenantId)
      .in("run_id", runIds)
      .eq("status", "running");
    if (stepError) {
      console.error("cancelActiveJourneyRuns steps failed:", stepError.message);
      return { ok: false, error: "Could not cancel the journey's active runs." };
    }
  }
  return { ok: true, value: { cancelled: runIds.length } };
}

/**
 * Retry checks, read with the signed-in user's client so RLS keeps them inside
 * the member's workspace. Database errors throw; callers report a generic failure.
 */
export async function createRunRetryLookups(): Promise<RunRetryLookups> {
  const supabase = await createClient();
  const fail = (operation: string, message: string): never => {
    throw new Error(`Run retry ${operation} failed: ${message}`);
  };
  return {
    async findRun(tenantId, runId) {
      const { data, error } = await supabase
        .from("journey_runs")
        .select("journey_id, contact_id, status, current_node_id, context")
        .eq("tenant_id", tenantId)
        .eq("id", runId)
        .maybeSingle();
      if (error) fail("run lookup", error.message);
      if (!data) return null;
      return {
        journeyId: data.journey_id as string,
        contactId: data.contact_id as string | null,
        status: data.status as JourneyRunStatus,
        currentNodeId: data.current_node_id as string | null,
        context: (data.context as RunState | null) ?? null,
      };
    },
    async latestStep(tenantId, runId) {
      const { data, error } = await supabase
        .from("journey_run_steps")
        .select("node_id, node_type, status, error")
        .eq("tenant_id", tenantId)
        .eq("run_id", runId)
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      if (error) fail("step lookup", error.message);
      if (!data) return null;
      return {
        nodeId: data.node_id as string,
        nodeType: data.node_type as string,
        status: data.status as JourneyStepStatus,
        error: data.error as string | null,
      };
    },
    async journeyStatus(tenantId, journeyId) {
      const { data, error } = await supabase
        .from("journeys")
        .select("status")
        .eq("tenant_id", tenantId)
        .eq("id", journeyId)
        .maybeSingle();
      if (error) fail("journey lookup", error.message);
      return data && isJourneyStatus(data.status) ? data.status : null;
    },
    async hasActiveRun(tenantId, journeyId, contactId) {
      const { count, error } = await supabase
        .from("journey_runs")
        .select("id", { count: "exact", head: true })
        .eq("tenant_id", tenantId)
        .eq("journey_id", journeyId)
        .eq("contact_id", contactId)
        .in("status", ACTIVE_STATUSES);
      if (error) fail("active run lookup", error.message);
      return (count ?? 0) > 0;
    },
  };
}

/**
 * Members can't write runs directly (select-only RLS). The checks read with the
 * user's client; only then does the service role apply the change, again
 * filtered by tenant.
 */
export async function retryFailedJourneyRun(
  tenantId: string,
  runId: string,
): Promise<RepositoryResult<{ journeyId: string }>> {
  const db = getSupabaseAdmin();
  if (!db) return { ok: false, error: "Journey runtime is unavailable." };
  try {
    const outcome = await retryJourneyRun(
      createSupabaseJourneyStore(db),
      await createRunRetryLookups(),
      tenantId,
      runId,
      new Date(),
    );
    if (outcome.result === "blocked") return { ok: false, error: RETRY_BLOCK_MESSAGES[outcome.reason] };
    return { ok: true, value: { journeyId: outcome.journeyId } };
  } catch (error) {
    console.error("retryFailedJourneyRun failed:", error instanceof Error ? error.message : "unknown error");
    return { ok: false, error: "Could not retry the run." };
  }
}

/**
 * Manual-enrollment checks, read with the signed-in user's client so RLS keeps
 * them inside the member's workspace. Database errors throw; callers report a
 * generic failure.
 */
export async function createManualEnrollmentLookups(): Promise<ManualEnrollmentLookups> {
  const supabase = await createClient();
  const fail = (operation: string, message: string): never => {
    throw new Error(`Manual enrollment ${operation} failed: ${message}`);
  };
  return {
    async contactExists(tenantId, contactId) {
      const { data, error } = await supabase
        .from("contacts")
        .select("id")
        .eq("tenant_id", tenantId)
        .eq("id", contactId)
        .maybeSingle();
      if (error) fail("contact lookup", error.message);
      return Boolean(data);
    },
    async findJourney(tenantId, journeyId) {
      const { data, error } = await supabase
        .from("journeys")
        .select("status, version")
        .eq("tenant_id", tenantId)
        .eq("id", journeyId)
        .maybeSingle();
      if (error) fail("journey lookup", error.message);
      if (!data || !isJourneyStatus(data.status)) return null;
      return { status: data.status, version: data.version as number };
    },
    async versionTriggerEvents(tenantId, journeyId, version) {
      const { data, error } = await supabase
        .from("journey_versions")
        .select("trigger_events")
        .eq("tenant_id", tenantId)
        .eq("journey_id", journeyId)
        .eq("version", version)
        .maybeSingle();
      if (error) fail("version lookup", error.message);
      return data ? ((data.trigger_events as string[] | null) ?? []) : null;
    },
    async hasActiveRun(tenantId, journeyId, contactId) {
      const { count, error } = await supabase
        .from("journey_runs")
        .select("id", { count: "exact", head: true })
        .eq("tenant_id", tenantId)
        .eq("journey_id", journeyId)
        .eq("contact_id", contactId)
        .in("status", ACTIVE_STATUSES);
      if (error) fail("active run lookup", error.message);
      return (count ?? 0) > 0;
    },
  };
}

/** Called after a paused journey is resumed (the caller already verified tenant ownership). */
export async function resumePausedRuns(tenantId: string, journeyId: string): Promise<void> {
  const db = getSupabaseAdmin();
  if (!db) return;
  const { error } = await db
    .from("journey_runs")
    .update({ status: "waiting", resume_at: new Date().toISOString(), paused_at: null })
    .eq("tenant_id", tenantId)
    .eq("journey_id", journeyId)
    .eq("status", "paused");
  if (error) console.error("resumePausedRuns failed:", error.message);
}
