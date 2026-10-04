/**
 * Journey worker behind /api/cron/journeys. Any scheduler (Supabase pg_cron +
 * pg_net, Vercel Cron, or a manual call) can invoke it with the cron secret;
 * no request body or scheduler-specific headers are needed.
 *
 * Invocations may overlap. The database claim/lease in the engine decides which
 * worker executes a run; this module only lists, time-boxes, and reports.
 *
 * Pure module (relative imports only) so it runs under node --test.
 */

import { resumeDueRuns, type EngineDeps, type ExecuteOutcome } from "./engine.ts";

export interface HeaderSource {
  get(name: string): string | null;
}

export type CronAuth = "ok" | "unconfigured" | "unauthorized";

function readCronSecret(headers: HeaderSource): string | null {
  const authorization = headers.get("authorization");
  if (authorization?.toLowerCase().startsWith("bearer ")) return authorization.slice(7).trim();
  return headers.get("x-cron-secret")?.trim() ?? null;
}

/** Accepts `Authorization: Bearer <secret>` or `x-cron-secret: <secret>`. */
export function authorizeCronRequest(headers: HeaderSource, configuredSecret: string | undefined): CronAuth {
  const secret = configuredSecret?.trim();
  if (!secret) return "unconfigured";
  const provided = readCronSecret(headers);
  return provided && provided === secret ? "ok" : "unauthorized";
}

export interface WorkerOptions {
  batchSize: number;
  maxBatches: number;
  /** No new run is started after this much time, so a pass rarely outlives the next invocation. */
  budgetMs: number;
}

export const DEFAULT_WORKER_OPTIONS: WorkerOptions = {
  batchSize: 25,
  maxBatches: 8,
  budgetMs: 50_000,
};

export interface WorkerSummary {
  /** Due runs listed across batches. */
  found: number;
  /** Runs this invocation claimed and executed. */
  claimed: number;
  /** Runs another worker claimed first. */
  skipped: number;
  /** Runs this invocation stopped because it lost the lease or the run was cancelled mid-pass. */
  leaseLost: number;
  /** Runs that ended this pass as failed journeys. */
  failed: number;
  /** Runs whose execution threw (infrastructure errors). Other runs still ran. */
  errors: number;
  /** Claimed runs by resulting status (completed, waiting, failed, ...). */
  statuses: Record<string, number>;
  batches: number;
  /** True when the time budget left due runs for the next invocation. */
  budgetReached: boolean;
  durationMs: number;
}

export async function runJourneyWorker(
  deps: EngineDeps,
  options: WorkerOptions = DEFAULT_WORKER_OPTIONS,
  clock: () => number = Date.now,
): Promise<WorkerSummary> {
  const started = clock();
  const withinBudget = () => clock() - started < options.budgetMs;
  const summary: WorkerSummary = {
    found: 0,
    claimed: 0,
    skipped: 0,
    leaseLost: 0,
    failed: 0,
    errors: 0,
    statuses: {},
    batches: 0,
    budgetReached: false,
    durationMs: 0,
  };

  const tally = (outcome: ExecuteOutcome) => {
    if (outcome.status === "not_claimed") summary.skipped++;
    else if (outcome.status === "lease_lost") summary.leaseLost++;
    else {
      summary.claimed++;
      summary.statuses[outcome.status] = (summary.statuses[outcome.status] ?? 0) + 1;
      if (outcome.status === "failed") summary.failed++;
    }
  };

  for (let batch = 0; batch < options.maxBatches; batch++) {
    if (!withinBudget()) {
      summary.budgetReached = true;
      break;
    }
    const result = await resumeDueRuns(deps, options.batchSize, { shouldContinue: withinBudget });
    summary.batches++;
    summary.found += result.found;
    summary.errors += result.errors;
    result.outcomes.forEach(tally);
    if (result.stopped) {
      summary.budgetReached = true;
      break;
    }
    // A short batch means nothing else is due right now; never wait for future work.
    if (result.found < options.batchSize) break;
  }

  summary.durationMs = clock() - started;
  return summary;
}

export interface WorkerResponse {
  status: number;
  body: Record<string, unknown>;
}

/**
 * Authenticates and runs one worker pass. Infrastructure failures (no database
 * client, due-run query failing) return 5xx; individual run failures don't.
 * Idle passes are quiet; responses and logs never include the secret.
 */
export async function handleJourneyWorkerRequest(
  headers: HeaderSource,
  env: {
    cronSecret: string | undefined;
    createDeps: () => EngineDeps | null;
    options?: WorkerOptions;
    clock?: () => number;
    log?: (message: string) => void;
  },
): Promise<WorkerResponse> {
  const log = env.log ?? ((message: string) => console.log(message));
  const auth = authorizeCronRequest(headers, env.cronSecret);
  if (auth === "unconfigured") return { status: 501, body: { error: "CRON_SECRET is not configured." } };
  if (auth === "unauthorized") return { status: 401, body: { error: "Unauthorized" } };

  const deps = env.createDeps();
  if (!deps) {
    log("Journey worker: database is not configured.");
    return { status: 503, body: { error: "Journey worker is not configured." } };
  }

  try {
    const summary = await runJourneyWorker(deps, env.options, env.clock);
    if (summary.found > 0 || summary.errors > 0) log(`Journey worker: ${JSON.stringify(summary)}`);
    return { status: 200, body: { ok: true, ...summary } };
  } catch (error) {
    log(`Journey worker failed: ${error instanceof Error ? error.message : "unknown error"}`);
    return { status: 500, body: { error: "Journey worker failed." } };
  }
}
