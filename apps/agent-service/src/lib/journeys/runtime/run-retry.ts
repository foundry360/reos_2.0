/**
 * Manual retry of a failed run: re-runs the step the run failed at, then the
 * journey continues as usual on the run's pinned version. Earlier steps never
 * run again; the worker picks the run up once it is waiting and due.
 *
 * Only a step known to have failed (the action or AI call threw) is retried. A
 * step whose side effect may or may not have happened stays failed.
 *
 * The checks read through lookups the caller scopes to the member's workspace
 * (the signed-in user's RLS client in production).
 *
 * Pure module (relative imports only) so it runs under node --test.
 */

import type { JourneyStatus } from "../journey-types.ts";
import {
  INTERRUPTED_STEP_ERROR,
  MAX_ATTEMPTS,
  type JourneyRuntimeStore,
  type RunState,
  type RunStatus,
  type StepStatus,
} from "./engine.ts";

export interface RetryRun {
  status: RunStatus;
  currentNodeId: string | null;
  context: Pick<RunState, "inFlight" | "waitingStepId"> | null;
}

export interface RetryStep {
  nodeId: string;
  nodeType: string;
  status: StepStatus;
  error: string | null;
}

export type RetryBlockReason =
  | "not_found"
  | "not_failed"
  | "journey_paused"
  | "journey_not_active"
  | "unknown_outcome"
  | "not_retryable_step"
  | "active_run";

export const RETRY_BLOCK_MESSAGES: Record<RetryBlockReason, string> = {
  not_found: "Run not found.",
  not_failed: "Only failed runs can be retried.",
  journey_paused: "Resume the journey before retrying its runs.",
  journey_not_active: "Only runs of active journeys can be retried.",
  unknown_outcome: "This step was interrupted and may already have run, so it can't be retried.",
  not_retryable_step: "This run didn't stop at a step that can be retried.",
  active_run: "This lead already has an active run of this journey. Cancel it or wait for it to finish.",
};

const RETRYABLE_NODE_TYPES = new Set(["action", "ai"]);

/**
 * Why the run can't be retried, or null when it can. `latestStep` is the run's
 * most recent step; `journeyStatus` is null when the journey no longer exists.
 */
export function retryBlockReason(
  run: RetryRun,
  latestStep: RetryStep | null,
  journeyStatus: JourneyStatus | null,
): RetryBlockReason | null {
  if (run.status !== "failed") return "not_failed";
  if (journeyStatus === null) return "not_found";
  if (journeyStatus === "paused") return "journey_paused";
  if (journeyStatus !== "active") return "journey_not_active";
  if (run.context?.inFlight) return "unknown_outcome";
  if (run.context?.waitingStepId || !run.currentNodeId) return "not_retryable_step";
  if (!latestStep || latestStep.nodeId !== run.currentNodeId || latestStep.status !== "failed") {
    return "not_retryable_step";
  }
  if (!RETRYABLE_NODE_TYPES.has(latestStep.nodeType)) return "not_retryable_step";
  if (latestStep.error === INTERRUPTED_STEP_ERROR) return "unknown_outcome";
  return null;
}

/**
 * The run's context for the retry: earlier outputs kept, one attempt left for
 * the failed node (so a transient failure ends the run again instead of
 * starting another automatic retry cycle), no leftover in-flight or wait state.
 */
export function retryContext(context: RunState, nodeId: string): RunState {
  const next = structuredClone(context);
  delete next.inFlight;
  delete next.waitingStepId;
  delete next.waitingForChild;
  delete next.waitingForChildren;
  next.steps = next.steps ?? {};
  next.attempts = { ...(next.attempts ?? {}), [nodeId]: MAX_ATTEMPTS - 1 };
  return next;
}

export interface RunRetryLookups {
  /** The run, or null when it isn't in this workspace. */
  findRun(
    tenantId: string,
    runId: string,
  ): Promise<(RetryRun & { journeyId: string; contactId: string | null; context: RunState | null }) | null>;
  latestStep(tenantId: string, runId: string): Promise<RetryStep | null>;
  /** Null when the journey isn't in this workspace. */
  journeyStatus(tenantId: string, journeyId: string): Promise<JourneyStatus | null>;
  hasActiveRun(tenantId: string, journeyId: string, contactId: string): Promise<boolean>;
}

export type RunRetryResult =
  | { result: "retried"; journeyId: string }
  | { result: "blocked"; reason: RetryBlockReason; journeyId: string | null };

/**
 * Checks the run and, only if it can be retried, makes it waiting and due at
 * `now`. The store write re-checks that the run is still failed at the same
 * node, and the active-run rule, so concurrent requests can't both apply.
 */
export async function retryJourneyRun(
  store: Pick<JourneyRuntimeStore, "retryFailedRun">,
  lookups: RunRetryLookups,
  tenantId: string,
  runId: string,
  now: Date,
): Promise<RunRetryResult> {
  const run = await lookups.findRun(tenantId, runId);
  if (!run) return { result: "blocked", reason: "not_found", journeyId: null };
  const blocked = (reason: RetryBlockReason): RunRetryResult => ({ result: "blocked", reason, journeyId: run.journeyId });

  const [journeyStatus, latestStep] = await Promise.all([
    lookups.journeyStatus(tenantId, run.journeyId),
    lookups.latestStep(tenantId, runId),
  ]);
  const reason = retryBlockReason(run, latestStep, journeyStatus);
  if (reason) return blocked(reason);
  const nodeId = run.currentNodeId as string;

  if (run.contactId && (await lookups.hasActiveRun(tenantId, run.journeyId, run.contactId))) {
    return blocked("active_run");
  }

  const written = await store.retryFailedRun(
    tenantId,
    runId,
    nodeId,
    retryContext(run.context ?? { steps: {} }, nodeId),
    now.toISOString(),
  );
  if (written === "retried") return { result: "retried", journeyId: run.journeyId };
  return blocked(written);
}
