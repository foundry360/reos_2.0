/**
 * Journey execution engine. Storage, CRM side effects, and AI are injected so
 * the engine runs identically in the request path, the cron worker, and tests.
 *
 * Lifecycle: an event creates at most one run per (event, journey, version)
 * (idempotency key), pinned to the version that was live at that moment. The
 * executor claims the run with a short lease, walks nodes until the journey
 * ends, a wait begins, a transient error schedules a retry, or a hard failure
 * occurs. Waits and retries never block: they set resume_at and release the
 * lease; the scheduled worker picks the run up when it is due.
 */

import type { JourneyStatus } from "../journey-types.ts";
import {
  aiOutputSchema,
  conditionRules,
  LEAD_REPLIED_FIELD,
  MAX_INPUTS_BYTES,
  parseInputMappings,
  parseResultExports,
  parseResultMappings,
  RESULT_SOURCE_PATTERN,
  waitMilliseconds,
  type ActionConfig,
  type AIConfig,
  type InputValue,
  type ResultMapping,
  type TriggerConfig,
  type TriggerEventType,
} from "./contracts.ts";
import { evaluateAll, evaluateRules, journeyInputs, resolveField, scalarValues, type ExecutionContext } from "./conditions.ts";
import {
  nextNodeId,
  resolveStepField,
  resolveStepReference,
  stepKeys,
  triggerNodes,
  type JourneySnapshot,
  type SnapshotNode,
} from "./graph.ts";
import { journeyAIStepOutput, type JourneyAIExecutor, type JourneyAIRequest } from "./ai.ts";

// ---------- Types ----------

export interface JourneyEvent {
  tenantId: string;
  type: TriggerEventType;
  /** Id of this occurrence (contact, message, activity, task, or a generated id). */
  sourceId: string;
  contactId: string | null;
  entityType: string;
  entityId: string | null;
  payload: Record<string, unknown>;
  /** Restricts dispatch to this journey (manual enrollment). Unset: every eligible journey in the tenant. */
  journeyId?: string;
  /** Never starts this journey from the event (the journey whose run caused it). Other journeys stay eligible. */
  excludeJourneyId?: string;
}

export type RunStatus = "running" | "waiting" | "completed" | "failed" | "cancelled" | "paused";
export type StepStatus = "pending" | "running" | "completed" | "failed" | "skipped";
export type ErrorKind = "transient" | "config";

export interface RunState {
  steps: Record<string, { output: Record<string, unknown> }>;
  /** Wait step that will complete when the run resumes. */
  waitingStepId?: string;
  /**
   * A Start journey step waiting for the run it started (`runId`). The step
   * completes once that run is completed, failed, or cancelled.
   */
  waitingForChild?: { nodeId: string; stepId: string; runId: string };
  /**
   * The results this run declared (journey.started trigger), captured from its
   * own step outputs in the same write that completed it. Never written again.
   */
  results?: Record<string, InputValue>;
  /** Set instead of `results` when a declared result couldn't be returned. */
  resultsError?: { reason: "results_invalid" | "results_too_large"; errors?: string[]; bytes?: number };
  /** Attempts made so far for the node being retried. */
  attempts?: Record<string, number>;
  /**
   * Set while a side-effecting step executes; still set on resume means the pass
   * stopped mid-step. `outcome` is set when the side effect succeeded but its step
   * couldn't be recorded, so the next pass records it instead of repeating it.
   */
  inFlight?: { nodeId: string; stepId: string; outcome?: StepOutcome };
}

/** A side effect that happened, as recorded on its step. */
export interface StepOutcome {
  status: "completed" | "skipped";
  output: Record<string, unknown>;
  completedAt: string;
}

export interface RunRecord {
  id: string;
  tenantId: string;
  journeyId: string;
  journeyVersion: number;
  contactId: string | null;
  status: RunStatus;
  currentNodeId: string | null;
  triggerEvent: string;
  triggerPayload: Record<string, unknown>;
  context: RunState;
  error: string | null;
  resumeAt: string | null;
  startedAt: string;
}

/** A run this worker leased; `lease` is the locked_until value it holds. */
export type ClaimedRun = RunRecord & { lease: string };

export type RunWriteResult = "updated" | "lease_lost";

export interface NewRun {
  tenantId: string;
  journeyId: string;
  journeyVersion: number;
  contactId: string | null;
  entityType: string;
  entityId: string | null;
  currentNodeId: string;
  triggerEvent: string;
  triggerPayload: Record<string, unknown>;
  idempotencyKey: string;
  resumeAt: string;
}

export interface RunPatch {
  status?: RunStatus;
  currentNodeId?: string | null;
  context?: RunState;
  error?: string | null;
  resumeAt?: string | null;
  completedAt?: string | null;
  pausedAt?: string | null;
  lockedUntil?: string | null;
}

export interface NewStep {
  tenantId: string;
  runId: string;
  nodeId: string;
  nodeType: string;
  nodeName: string;
  status: StepStatus;
  input: Record<string, unknown>;
  output?: Record<string, unknown>;
  error?: string | null;
  errorKind?: ErrorKind | null;
  attemptCount?: number;
  completedAt?: string | null;
}

export interface StepPatch {
  status?: StepStatus;
  output?: Record<string, unknown>;
  error?: string | null;
  errorKind?: ErrorKind | null;
  completedAt?: string | null;
}

/** "not_failed": no failed run in this tenant stopped at that node. "active_run": the contact already has an active run of the journey. */
export type RunRetryWriteResult = "retried" | "not_failed" | "active_run";

export type CreateRunResult =
  | { run: RunRecord; created: boolean; alreadyActive?: false }
  | { run: null; created: false; alreadyActive: true };

export interface CandidateJourney {
  journeyId: string;
  version: number;
  snapshot: JourneySnapshot;
}

export interface LoadedEntities {
  lead: Record<string, unknown> | null;
  opportunity: Record<string, unknown> | null;
}

/** Persistence used by the engine. Every method is scoped to the tenant it is given. */
export interface JourneyRuntimeStore {
  /** Active journeys in the tenant whose current version listens for this event. */
  findCandidateJourneys(tenantId: string, event: TriggerEventType): Promise<CandidateJourney[]>;
  hasActiveRun(tenantId: string, journeyId: string, contactId: string): Promise<boolean>;
  /**
   * Inserts unless (tenant, idempotencyKey) exists (returns that run, created
   * false) or the contact already has an active run of the journey (alreadyActive).
   */
  createRun(run: NewRun): Promise<CreateRunResult>;
  /** Atomically leases a running/waiting run that isn't leased; marks it running. */
  claimRun(runId: string, now: Date, leaseUntil: Date): Promise<ClaimedRun | null>;
  /**
   * Applies the patch only while the run is still running under `lease` (the
   * locked_until value this worker last wrote). Returns "lease_lost" when the
   * run was cancelled or re-claimed; throws on database errors.
   */
  updateRun(runId: string, lease: string, patch: RunPatch): Promise<RunWriteResult>;
  /**
   * Manual retry: moves a failed run that stopped at `expectedNodeId` back to
   * waiting (due at `resumeAt`, unleased, error and completion cleared) with the
   * given context. One atomic write; the one-active-run rule still applies.
   */
  retryFailedRun(
    tenantId: string,
    runId: string,
    expectedNodeId: string,
    context: RunState,
    resumeAt: string,
  ): Promise<RunRetryWriteResult>;
  loadSnapshot(journeyId: string, version: number): Promise<JourneySnapshot | null>;
  journeyStatus(tenantId: string, journeyId: string): Promise<JourneyStatus | null>;
  insertStep(step: NewStep): Promise<string>;
  updateStep(stepId: string, patch: StepPatch): Promise<void>;
  loadStep(tenantId: string, stepId: string): Promise<{ status: StepStatus; output: Record<string, unknown> } | null>;
  loadEntities(tenantId: string, contactId: string | null): Promise<LoadedEntities>;
  /** Whether the contact sent any inbound message at or after `since`. */
  hasInboundMessageSince(tenantId: string, contactId: string, since: string): Promise<boolean>;
  listDueRunIds(now: Date, limit: number): Promise<string[]>;
  /** The run with this key in the tenant (a Start journey step's child), if any. */
  findRunByIdempotencyKey(tenantId: string, idempotencyKey: string): Promise<ChildRun | null>;
  /**
   * Makes `parentRunId` due now, only while it is waiting for `childRunId`
   * (context.waitingForChild.runId). Anything else is left alone.
   */
  wakeWaitingParent(tenantId: string, parentRunId: string, childRunId: string, now: Date): Promise<void>;
}

export interface ActionInput {
  tenantId: string;
  runId: string;
  nodeId: string;
  contactId: string | null;
  lead: Record<string, unknown> | null;
  opportunity: Record<string, unknown> | null;
}

export type ActionResult =
  | { status: "completed"; output: Record<string, unknown> }
  | { status: "skipped"; output: Record<string, unknown>; reason: string };

export interface ActionExecutor {
  execute(action: Exclude<ActionConfig, { action: "wait" }>, input: ActionInput): Promise<ActionResult>;
}

export interface EngineDeps {
  store: JourneyRuntimeStore;
  actions: ActionExecutor;
  ai: JourneyAIExecutor;
  now?: () => Date;
}

/** Thrown by actions. "config" never retries; "transient" retries with backoff. */
export class JourneyStepError extends Error {
  kind: ErrorKind;
  constructor(message: string, kind: ErrorKind) {
    super(message);
    this.name = "JourneyStepError";
    this.kind = kind;
  }
}

export const MAX_ATTEMPTS = 3;
export const RETRY_BACKOFF_MS = [60_000, 5 * 60_000, 30 * 60_000];
export const LEASE_MS = 2 * 60_000;
export const MAX_STEPS_PER_PASS = 50;
/**
 * Longest chain of journey runs linked by journey-caused events (a status change
 * a run made, or a run's Start journey step). A run started by any other event is
 * depth 1; a run started by a journey-caused event from a depth-N run is depth
 * N + 1. No run deeper than this starts.
 */
export const MAX_JOURNEY_CAUSATION_DEPTH = 3;

/** Events a journey run causes. A run started by one inherits the causing run's depth and root. */
export const JOURNEY_CAUSED_EVENTS: ReadonlySet<string> = new Set(["lead.status_changed", "journey.started"]);

/**
 * A run's depth. Only a run started by a journey-caused event inherits depth;
 * anything else (a person, the agent, an inbound message) is 1. A missing or
 * malformed recorded depth (runs from before depth existed) counts as 0, so
 * such a run is 1, the same as a run started by an outside change.
 */
export function runCausationDepth(run: Pick<RunRecord, "triggerEvent" | "triggerPayload">): number {
  if (!JOURNEY_CAUSED_EVENTS.has(run.triggerEvent)) return 1;
  const recorded = run.triggerPayload.causation_depth;
  const eventDepth = typeof recorded === "number" && Number.isInteger(recorded) && recorded >= 0 ? recorded : 0;
  return eventDepth + 1;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The first run of the chain `runId` belongs to: its recorded root_run_id when
 * it was started by a journey-caused event and the value is a uuid, else the
 * run itself. Observability only; never read for depth, exclusion, or access.
 */
export function runRootId(run: Pick<RunRecord, "triggerEvent" | "triggerPayload">, runId: string): string {
  const recorded = JOURNEY_CAUSED_EVENTS.has(run.triggerEvent) ? run.triggerPayload.root_run_id : undefined;
  return typeof recorded === "string" && UUID.test(recorded) ? recorded : runId;
}

/**
 * True when a journey-caused event at this depth must start no runs (depth 0–2
 * dispatch; 3 and up don't). Anything that isn't a non-negative integer is
 * treated as limited, so a malformed depth can never open the chain.
 */
export function isCausationDepthLimited(depth: number): boolean {
  return !(Number.isInteger(depth) && depth >= 0 && depth < MAX_JOURNEY_CAUSATION_DEPTH);
}

/** Written on a step (and its run) whose side effect may or may not have happened. */
export const INTERRUPTED_STEP_ERROR = "The step was interrupted and may or may not have completed, so it wasn't retried.";

/** Error on runs cancelled because their journey was archived. */
export const JOURNEY_ARCHIVED_ERROR = "Journey archived.";

/** Steps that can safely run twice if the process died mid-step (Start journey: its run key makes a repeat a no-op). */
const SAFE_TO_REPEAT = new Set(["update_lead", "assign_lead", "start_journey"]);

/** Actions that change lead or opportunity data later steps read, so the pass reloads it after they succeed. */
const CHANGES_ENTITIES = new Set(["update_lead", "assign_lead"]);

/**
 * Events that can be delivered more than once (outbox redelivery; a Start
 * journey step repeated by a retry). Their run key leaves out the journey
 * version, so one event starts a journey at most once even if the journey was
 * saved (new version) between deliveries.
 */
const ONCE_PER_JOURNEY_EVENTS = new Set<string>(["lead.status_changed", "journey.started"]);

export function idempotencyKey(event: Pick<JourneyEvent, "type" | "sourceId">, journeyId: string, version: number) {
  const key = `${event.type}:${event.sourceId}:${journeyId}`;
  return ONCE_PER_JOURNEY_EVENTS.has(event.type) ? key : `${key}:v${version}`;
}

/** The run key of the run a Start journey step starts: the one child that step is ever tied to. */
function childRunKey(parentRunId: string, nodeId: string, targetJourneyId: string): string {
  return idempotencyKey({ type: "journey.started", sourceId: `${parentRunId}:${nodeId}` }, targetJourneyId, 0);
}

/** Run statuses that never change again (short of a manual retry of a failed run). */
const TERMINAL_RUN_STATUSES: ReadonlySet<RunStatus> = new Set(["completed", "failed", "cancelled"]);

/**
 * A waited-for run's outcome, as `child_status` on the Start journey step.
 * "missing": the run no longer exists (its row was deleted), so there is nothing to wait for.
 */
export type ChildRunStatus = "completed" | "failed" | "cancelled" | "missing";

/**
 * How often a run waiting for its child checks the child again on its own. The
 * child wakes its parent when it finishes; this only recovers a wake-up that
 * was lost (the process died between the child finishing and waking it).
 */
export const CHILD_WAIT_RECHECK_MS = 60 * 60_000;

/**
 * A Start journey step's child as its parent sees it: status plus, once it
 * completed, the results it captured (`results` / `resultsError` from its
 * context). Read from storage, so treated as untrusted.
 */
export interface ChildRun {
  id: string;
  status: RunStatus;
  results?: unknown;
  resultsError?: unknown;
}

export type ResultsErrorReason = "results_invalid" | "results_too_large" | "results_not_exported";

/**
 * What a waiting Start journey step with result mappings adds to its output
 * once the child is terminal: `results` with exactly one value per mapping,
 * taken from the child's captured results (never re-resolved). Nothing for a
 * child that failed, was cancelled, or is missing. If the child couldn't
 * capture its results, doesn't declare a mapped name, or a value isn't a
 * scalar, `results` is empty and `results_error` says why: all or nothing.
 */
function receivedResults(mappings: ResultMapping[], child: ChildRun | null): Record<string, unknown> {
  if (mappings.length === 0) return {};
  if (!child || child.status !== "completed") return { results: {} };
  const captureError = child.resultsError as RunState["resultsError"] | undefined;
  if (captureError) {
    const reason = captureError.reason === "results_too_large" ? "results_too_large" : "results_invalid";
    return { results: {}, results_error: reason };
  }
  const declared =
    child.results && typeof child.results === "object" && !Array.isArray(child.results)
      ? (child.results as Record<string, unknown>)
      : {};
  const entries = mappings.map(({ target, source }) => ({ target, source: RESULT_SOURCE_PATTERN.exec(source)?.[1] ?? "" }));
  const notExported = entries.filter(({ source }) => !source || !Object.hasOwn(declared, source));
  if (notExported.length > 0) {
    return {
      results: {},
      results_error: "results_not_exported" satisfies ResultsErrorReason,
      result_errors: notExported.map(({ target, source }) => `Result "${target}": the started journey doesn't return "${source}".`),
    };
  }
  const values = scalarValues(entries, (name) => declared[name], "Result");
  if (values.ok) return { results: values.values };
  return values.reason === "invalid"
    ? { results: {}, results_error: "results_invalid" satisfies ResultsErrorReason, result_errors: values.errors }
    : { results: {}, results_error: "results_too_large" satisfies ResultsErrorReason };
}

/**
 * The results a completing run started by journey.started returns: the
 * declared exports of its journey.started trigger, resolved from its own
 * recorded step outputs only. Empty when it declares none.
 */
function capturedResults(
  snapshot: JourneySnapshot,
  resolve: (source: string) => unknown,
): Pick<RunState, "results" | "resultsError"> {
  const trigger = snapshot.nodes.find((node) => node.type === "trigger" && node.config.event === "journey.started");
  if (!trigger || trigger.config.results === undefined) return {};
  const parsed = parseResultExports(trigger.config.results, "strict");
  if (parsed.errors.length > 0) return { resultsError: { reason: "results_invalid", errors: parsed.errors.slice(0, 10) } };
  if (parsed.exports.length === 0) return {};
  const values = scalarValues(parsed.exports.map(({ name, source }) => ({ target: name, source })), resolve, "Result");
  if (values.ok) return { results: values.values };
  return values.reason === "invalid"
    ? { resultsError: { reason: "results_invalid", errors: values.errors } }
    : { resultsError: { reason: "results_too_large", bytes: values.bytes } };
}

/** A failed AI result becomes a step error so the normal retry/fail path handles it. */
async function runAINode(executor: JourneyAIExecutor, request: JourneyAIRequest): Promise<ActionResult> {
  const result = await executor.execute(request);
  if (!result.success) throw new JourneyStepError(result.error, result.retryable ? "transient" : "config");
  return { status: "completed", output: journeyAIStepOutput(result) };
}

/** The output of a step whose side effect was recorded as finished, if it was. */
async function recordedOutcome(store: JourneyRuntimeStore, tenantId: string, stepId: string) {
  const step = await store.loadStep(tenantId, stepId);
  return step && (step.status === "completed" || step.status === "skipped") ? { output: step.output } : null;
}

function classify(error: unknown): { message: string; kind: ErrorKind } {
  if (error instanceof JourneyStepError) return { message: error.message, kind: error.kind };
  const message = error instanceof Error ? error.message : String(error);
  return { message: message || "Unexpected error.", kind: "transient" };
}

// ---------- Dispatch ----------

export interface DispatchOutcome {
  journeyId: string;
  version: number;
  runId: string | null;
  result: "started" | "duplicate" | "filtered" | "already_active";
  execution?: ExecuteOutcome;
}

/**
 * Starts runs for every active journey listening for this event. Candidates are
 * filtered in the database by tenant + trigger event; trigger filters are
 * evaluated here against freshly loaded CRM data. With `execute: false`, created
 * runs are left due for the caller (or the worker) to execute.
 */
export async function dispatchJourneyEvent(
  deps: EngineDeps,
  event: JourneyEvent,
  options: { execute?: boolean } = {},
): Promise<DispatchOutcome[]> {
  const now = deps.now ?? (() => new Date());
  const candidates = (await deps.store.findCandidateJourneys(event.tenantId, event.type)).filter(
    (candidate) =>
      (event.journeyId === undefined || candidate.journeyId === event.journeyId) &&
      candidate.journeyId !== event.excludeJourneyId,
  );
  if (candidates.length === 0) return [];

  const entities = await deps.store.loadEntities(event.tenantId, event.contactId);
  const context: ExecutionContext = {
    ...entities,
    trigger: { event: event.type, payload: event.payload },
    steps: {},
  };

  const outcomes: DispatchOutcome[] = [];
  for (const candidate of candidates) {
    const trigger = triggerNodes(candidate.snapshot).find((node) => {
      const config = node.config as unknown as TriggerConfig;
      return config.event === event.type && evaluateAll(config.filters ?? [], context);
    });
    if (!trigger) {
      outcomes.push({ journeyId: candidate.journeyId, version: candidate.version, runId: null, result: "filtered" });
      continue;
    }

    if (event.contactId && (await deps.store.hasActiveRun(event.tenantId, candidate.journeyId, event.contactId))) {
      outcomes.push({
        journeyId: candidate.journeyId,
        version: candidate.version,
        runId: null,
        result: "already_active",
      });
      continue;
    }

    const result = await deps.store.createRun({
      tenantId: event.tenantId,
      journeyId: candidate.journeyId,
      journeyVersion: candidate.version,
      contactId: event.contactId,
      entityType: event.entityType,
      entityId: event.entityId,
      currentNodeId: trigger.id,
      triggerEvent: event.type,
      triggerPayload: event.payload,
      idempotencyKey: idempotencyKey(event, candidate.journeyId, candidate.version),
      // Due immediately: if inline execution never happens, the worker runs it.
      resumeAt: now().toISOString(),
    });

    // Another event started a run for this contact after the check above.
    if (result.alreadyActive) {
      outcomes.push({ journeyId: candidate.journeyId, version: candidate.version, runId: null, result: "already_active" });
      continue;
    }
    const { run, created } = result;
    if (!created) {
      outcomes.push({ journeyId: candidate.journeyId, version: candidate.version, runId: run.id, result: "duplicate" });
      continue;
    }
    if (options.execute === false) {
      outcomes.push({ journeyId: candidate.journeyId, version: candidate.version, runId: run.id, result: "started" });
      continue;
    }
    const execution = await executeRun(deps, run.id);
    outcomes.push({ journeyId: candidate.journeyId, version: candidate.version, runId: run.id, result: "started", execution });
  }
  return outcomes;
}

/** Why a Start journey step started nothing. Recorded on the step; never a run failure. */
export type StartJourneySkipReason =
  | "self_start"
  | "no_contact"
  | "target_not_found"
  | "target_inactive"
  | "depth_limited"
  | "inputs_invalid"
  | "inputs_too_large"
  | "target_not_listening"
  | "trigger_filters_not_matched"
  | "already_active";

/**
 * A Start journey step: a journey.started event targeted at one journey in the
 * run's workspace, through the normal dispatcher (trigger filters, one active
 * run per contact, idempotent run creation). The run key is
 * journey.started:<run id>:<node id>:<target journey id>, so repeating the step
 * (retry, interrupted pass, two workers) never starts a second child. The child
 * gets lineage (origin, origin run and journey, root, depth) and, when the step
 * maps any, `inputs`: one value per mapping, read by `resolve` from what this
 * run can already read. Nothing else of this run crosses over. Inputs are fixed
 * when the child is created; a repeated step never changes them. A started
 * child is returned in `started` for the caller to execute after this pass.
 *
 * Without waitForCompletion this run continues at once. With it, the result is
 * "waiting" on the child (the caller parks this run) unless the child has
 * already finished. A child an earlier attempt of this step created is found
 * by its run key and is always the one waited for; a run of the target that
 * belongs to anything else (already_active) is never waited for.
 */
async function startJourney(
  deps: EngineDeps,
  run: RunRecord,
  nodeId: string,
  action: Extract<ActionConfig, { action: "start_journey" }>,
  resolve: (source: string) => unknown,
  started: string[],
): Promise<ActionResult | { status: "waiting"; output: Record<string, unknown>; runId: string }> {
  const targetJourneyId = action.journeyId;
  const wait = action.waitForCompletion === true;
  const depth = runCausationDepth(run);
  const skip = (reason: StartJourneySkipReason, extra: Record<string, unknown> = {}): ActionResult => ({
    status: "skipped",
    output: { started: false, target_journey_id: targetJourneyId, ...extra },
    reason,
  });
  const resultMappings = wait ? parseResultMappings(action.resultMappings, "draft").mappings : [];
  const child = (found: ChildRun, duplicate: boolean) => {
    const output = {
      started: true,
      target_journey_id: targetJourneyId,
      run_id: found.id,
      causation_depth: depth,
      ...(duplicate ? { duplicate: true } : {}),
    };
    return TERMINAL_RUN_STATUSES.has(found.status)
      ? { status: "completed" as const, output: { ...output, child_status: found.status, ...receivedResults(resultMappings, found) } }
      : { status: "waiting" as const, output: { ...output, waiting: true }, runId: found.id };
  };
  if (targetJourneyId === run.journeyId) return skip("self_start");
  if (!run.contactId) return skip("no_contact");

  if (wait) {
    const existing = await deps.store.findRunByIdempotencyKey(run.tenantId, childRunKey(run.id, nodeId, targetJourneyId));
    if (existing) return child(existing, true);
  }

  const status = await deps.store.journeyStatus(run.tenantId, targetJourneyId);
  if (status === null) return skip("target_not_found");
  if (status !== "active") return skip("target_inactive", { target_status: status });

  if (isCausationDepthLimited(depth)) return skip("depth_limited", { causation_depth: depth });

  // Snapshots are parsed leniently, so the list is checked strictly again here.
  const mappings = parseInputMappings(action.inputMappings, "strict");
  if (mappings.errors.length > 0) return skip("inputs_invalid", { input_errors: mappings.errors });
  const resolved = journeyInputs(mappings.mappings, resolve);
  if (!resolved.ok) {
    return resolved.reason === "inputs_invalid"
      ? skip("inputs_invalid", { input_errors: resolved.errors })
      : skip("inputs_too_large", { inputs_bytes: resolved.bytes, max_inputs_bytes: MAX_INPUTS_BYTES });
  }

  const [outcome] = await dispatchJourneyEvent(
    deps,
    {
      tenantId: run.tenantId,
      type: "journey.started",
      sourceId: `${run.id}:${nodeId}`,
      contactId: run.contactId,
      entityType: "contact",
      entityId: run.contactId,
      journeyId: targetJourneyId,
      payload: {
        origin: "journey",
        origin_run_id: run.id,
        origin_journey_id: run.journeyId,
        root_run_id: runRootId(run, run.id),
        causation_depth: depth,
        ...(mappings.mappings.length > 0 ? { inputs: resolved.inputs } : {}),
      },
    },
    { execute: false },
  );
  if (!outcome) return skip("target_not_listening");
  if (outcome.result === "filtered") return skip("trigger_filters_not_matched");
  if (outcome.result === "already_active") return skip("already_active");
  if (outcome.result === "started" && outcome.runId) started.push(outcome.runId);
  if (wait && outcome.runId) {
    const existing =
      outcome.result === "duplicate" ? await deps.store.findRunByIdempotencyKey(run.tenantId, childRunKey(run.id, nodeId, targetJourneyId)) : null;
    return child(existing ?? { id: outcome.runId, status: "running" }, outcome.result === "duplicate");
  }
  return {
    status: "completed",
    output: {
      started: true,
      target_journey_id: targetJourneyId,
      run_id: outcome.runId,
      causation_depth: depth,
      ...(outcome.result === "duplicate" ? { duplicate: true } : {}),
    },
  };
}

// ---------- Execution ----------

export interface ExecuteOutcome {
  /** "lease_lost": the run was cancelled or another worker took it over; this pass stopped. */
  status: RunStatus | "not_claimed" | "lease_lost";
  steps: number;
  /** Set when the pass parked the run to wait for this child run. */
  waitingForChild?: string;
}

/**
 * Runs one leased pass over a run. Safe to call concurrently: only one caller
 * wins the lease. Every run write renews the lease and succeeds only while
 * this worker still holds it, so the pass stops at the next step boundary
 * once the run is cancelled or re-claimed, before any further side effect.
 *
 * Runs started by this pass's Start journey steps execute after it, outside its
 * lease. They are already due, so if that fails the worker runs them. When the
 * pass parked to wait for one of them, the run gets one more pass afterwards:
 * it continues if that child finished, and otherwise parks again.
 */
export async function executeRun(deps: EngineDeps, runId: string): Promise<ExecuteOutcome> {
  const started: string[] = [];
  const outcome = await executePass(deps, runId, started);
  for (const childId of started) {
    try {
      await executeRun(deps, childId);
    } catch (error) {
      console.error("[journeys] started run failed to execute:", childId, error instanceof Error ? error.message : error);
    }
  }
  if (outcome.waitingForChild && started.includes(outcome.waitingForChild)) {
    try {
      const resumed = await executeRun(deps, runId);
      if (resumed.status !== "not_claimed") return resumed;
    } catch (error) {
      console.error("[journeys] waiting run failed to resume:", runId, error instanceof Error ? error.message : error);
    }
  }
  return outcome;
}

async function executePass(deps: EngineDeps, runId: string, started: string[]): Promise<ExecuteOutcome> {
  const { store } = deps;
  const now = deps.now ?? (() => new Date());
  const claimedAt = now();
  const run = await store.claimRun(runId, claimedAt, new Date(claimedAt.getTime() + LEASE_MS));
  if (!run) return { status: "not_claimed", steps: 0 };

  let lease = run.lease;
  let executed = 0;

  /** Writes run state under the current lease, renewing it unless the patch releases it. */
  const write = async (patch: RunPatch): Promise<boolean> => {
    const next =
      patch.lockedUntil !== undefined ? patch.lockedUntil : new Date(now().getTime() + LEASE_MS).toISOString();
    if ((await store.updateRun(run.id, lease, { ...patch, lockedUntil: next })) === "lease_lost") return false;
    if (next) lease = next;
    return true;
  };
  const leaseLost = (): ExecuteOutcome => ({ status: "lease_lost", steps: executed });

  const finish = async (status: RunStatus, patch: RunPatch = {}): Promise<ExecuteOutcome> => {
    const terminal = status === "completed" || status === "failed" || status === "cancelled";
    const written = await write({
      status,
      lockedUntil: null,
      ...(terminal ? { completedAt: now().toISOString(), resumeAt: null } : {}),
      ...patch,
    });
    if (!written) return leaseLost();
    if (terminal) await wakeOrigin();
    return { status, steps: executed };
  };

  /** A finished run started by a Start journey step wakes that step's run if it is waiting for this one. */
  const wakeOrigin = async () => {
    const origin = run.triggerEvent === "journey.started" ? run.triggerPayload.origin_run_id : undefined;
    if (typeof origin !== "string" || !UUID.test(origin)) return;
    try {
      await store.wakeWaitingParent(run.tenantId, origin, run.id, now());
    } catch (error) {
      // The parent's own recheck (CHILD_WAIT_RECHECK_MS) recovers a lost wake-up.
      console.error("[journeys] couldn't wake the waiting run:", origin, error instanceof Error ? error.message : error);
    }
  };

  /**
   * Parks this run on its child: waiting, unleased, rechecking at the latest
   * after CHILD_WAIT_RECHECK_MS. The child is checked once more after the write,
   * so a child that finished before this run was waiting (and so couldn't wake
   * it) still makes it due now.
   */
  const waitForChild = async (patch: RunPatch, childRunId: string, childKey: string): Promise<ExecuteOutcome> => {
    const parked = await finish("waiting", { ...patch, resumeAt: new Date(now().getTime() + CHILD_WAIT_RECHECK_MS).toISOString() });
    if (parked.status !== "waiting") return parked;
    try {
      const child = await store.findRunByIdempotencyKey(run.tenantId, childKey);
      if (!child || TERMINAL_RUN_STATUSES.has(child.status)) await store.wakeWaitingParent(run.tenantId, run.id, childRunId, now());
    } catch (error) {
      console.error("[journeys] couldn't recheck the waited-for run:", childRunId, error instanceof Error ? error.message : error);
    }
    return { ...parked, waitingForChild: childRunId };
  };

  const journeyStatus = await store.journeyStatus(run.tenantId, run.journeyId);
  if (journeyStatus === null) return finish("cancelled", { error: "The journey was deleted." });
  // Archiving cancels active runs; this catches a run started or resumed around that moment.
  if (journeyStatus === "archived") return finish("cancelled", { error: JOURNEY_ARCHIVED_ERROR });
  if (journeyStatus === "paused") {
    return finish("paused", { pausedAt: now().toISOString(), resumeAt: null });
  }

  const snapshot = await store.loadSnapshot(run.journeyId, run.journeyVersion);
  if (!snapshot) return finish("failed", { error: `Version ${run.journeyVersion} of this journey is missing.` });

  const keys = stepKeys(snapshot.nodes);
  const state: RunState = { steps: { ...(run.context.steps ?? {}) }, attempts: { ...(run.context.attempts ?? {}) } };
  let currentNodeId = run.currentNodeId;

  let entities = await store.loadEntities(run.tenantId, run.contactId);
  const context = (): ExecutionContext => ({
    ...entities,
    trigger: { event: run.triggerEvent, payload: run.triggerPayload },
    steps: state.steps,
  });

  const recordOutput = (node: SnapshotNode, output: Record<string, unknown>) => {
    state.steps[keys.get(node.id) ?? node.id] = { output };
  };
  const persist = () => write({ currentNodeId, context: state });

  // A wait finished: close its step and move past it.
  if (run.context.waitingStepId && currentNodeId) {
    const node = snapshot.nodes.find((entry) => entry.id === currentNodeId);
    const output = { resumed_at: now().toISOString() };
    await store.updateStep(run.context.waitingStepId, {
      status: "completed",
      output,
      completedAt: now().toISOString(),
    });
    if (node) recordOutput(node, output);
    currentNodeId = nextNodeId(snapshot, currentNodeId);
    if (!(await persist())) return leaseLost();
  }

  // Waiting for a child: continue once it finished, else park again. The child is
  // found by its run key, never by anything else that happened to the lead.
  const waiting = run.context.waitingForChild;
  if (waiting && currentNodeId === waiting.nodeId) {
    const node = snapshot.nodes.find((entry) => entry.id === waiting.nodeId);
    const config = node?.type === "action" ? (node.config as unknown as ActionConfig) : null;
    if (!node || config?.action !== "start_journey") {
      return finish("failed", { error: "The journey points to a step that doesn't exist.", context: state, currentNodeId });
    }
    const childKey = childRunKey(run.id, node.id, config.journeyId);
    const child = await store.findRunByIdempotencyKey(run.tenantId, childKey);
    if (child && !TERMINAL_RUN_STATUSES.has(child.status)) return waitForChild({}, child.id, childKey);

    const recorded = await store.loadStep(run.tenantId, waiting.stepId);
    const { waiting: _waiting, ...base } = recorded?.output ?? { started: true, target_journey_id: config.journeyId, run_id: waiting.runId };
    const childStatus: ChildRunStatus = child ? (child.status as ChildRunStatus) : "missing";
    const output = {
      ...base,
      child_status: childStatus,
      ...receivedResults(parseResultMappings(config.resultMappings, "draft").mappings, child),
    };
    await store.updateStep(waiting.stepId, { status: "completed", output, completedAt: now().toISOString() });
    recordOutput(node, output);
    currentNodeId = nextNodeId(snapshot, node.id);
    if (!(await persist())) return leaseLost();
  }

  // The previous pass stopped while a side effect was executing or being recorded.
  const inFlightNode = run.context.inFlight && snapshot.nodes.find((entry) => entry.id === run.context.inFlight!.nodeId);
  const recovered =
    run.context.inFlight && inFlightNode
      ? (run.context.inFlight.outcome ?? (await recordedOutcome(store, run.tenantId, run.context.inFlight.stepId)))
      : null;
  if (run.context.inFlight && inFlightNode && recovered) {
    // The side effect happened; only its bookkeeping is missing. Finish that instead of repeating it.
    const { nodeId, stepId, outcome } = run.context.inFlight;
    if (outcome) await store.updateStep(stepId, outcome);
    recordOutput(inFlightNode, recovered.output);
    if (state.attempts) delete state.attempts[nodeId];
    currentNodeId = nextNodeId(snapshot, nodeId);
    if (!(await persist())) return leaseLost();
  } else if (run.context.inFlight) {
    const { nodeId, stepId } = run.context.inFlight;
    const node = snapshot.nodes.find((entry) => entry.id === nodeId);
    const action = node?.type === "action" ? String(node.config.action ?? "") : "";
    if (!SAFE_TO_REPEAT.has(action) && node?.type !== "ai") {
      await store.updateStep(stepId, {
        status: "failed",
        error: INTERRUPTED_STEP_ERROR,
        errorKind: "config",
        completedAt: now().toISOString(),
      });
      return finish("failed", { error: INTERRUPTED_STEP_ERROR, context: state, currentNodeId: nodeId });
    }
    await store.updateStep(stepId, { status: "failed", error: "Interrupted; retrying.", errorKind: "transient", completedAt: now().toISOString() });
  }

  while (currentNodeId) {
    if (executed >= MAX_STEPS_PER_PASS) {
      return finish("running", { currentNodeId, context: state, resumeAt: now().toISOString() });
    }
    const node = snapshot.nodes.find((entry) => entry.id === currentNodeId);
    if (!node) {
      return finish("failed", { error: "The journey points to a step that doesn't exist.", context: state, currentNodeId });
    }
    executed++;
    const startedAt = now().toISOString();
    const base = {
      tenantId: run.tenantId,
      runId: run.id,
      nodeId: node.id,
      nodeType: node.type,
      nodeName: node.name,
    };

    if (node.type === "trigger") {
      const output = { event: run.triggerEvent, ...run.triggerPayload };
      await store.insertStep({ ...base, status: "completed", input: {}, output, completedAt: startedAt });
      recordOutput(node, output);
      currentNodeId = nextNodeId(snapshot, node.id);
      if (!(await persist())) return leaseLost();
      continue;
    }

    if (node.type === "condition") {
      const { logic, rules } = conditionRules(node.config);
      const resolved = rules.map((rule) => resolveStepReference(rule, snapshot.nodes, keys));
      const conditionContext = context();
      // Checked when the condition runs, so a reply that arrived during a wait counts. One lookup serves every rule.
      if (resolved.some((rule) => rule.field === LEAD_REPLIED_FIELD) && run.contactId && conditionContext.lead) {
        const replied = await store.hasInboundMessageSince(run.tenantId, run.contactId, run.startedAt);
        conditionContext.lead = { ...conditionContext.lead, [LEAD_REPLIED_FIELD.slice("lead.".length)]: replied };
      }
      const result = evaluateRules(logic, resolved, conditionContext);
      const output = { result, branch: result ? "yes" : "no" };
      await store.insertStep({ ...base, status: "completed", input: { ...node.config }, output, completedAt: startedAt });
      recordOutput(node, output);
      currentNodeId = nextNodeId(snapshot, node.id, result);
      if (!(await persist())) return leaseLost();
      continue;
    }

    const action = node.type === "action" ? (node.config as unknown as ActionConfig) : null;

    if (action?.action === "wait") {
      const resumeAt = new Date(now().getTime() + waitMilliseconds(action.duration, action.unit)).toISOString();
      const stepId = await store.insertStep({
        ...base,
        status: "running",
        input: { duration: action.duration, unit: action.unit },
        output: { resume_at: resumeAt },
      });
      return finish("waiting", {
        currentNodeId: node.id,
        context: { ...state, waitingStepId: stepId },
        resumeAt,
      });
    }

    // Side-effecting step: action or AI.
    let outcome: StepOutcome | null = null;
    let waitFor: { runId: string; output: Record<string, unknown> } | null = null;
    const attempt = (state.attempts?.[node.id] ?? 0) + 1;
    const input = { ...node.config };
    const stepId = await store.insertStep({ ...base, status: "running", input, attemptCount: attempt });
    if (!(await write({ currentNodeId, context: { ...state, inFlight: { nodeId: node.id, stepId } } }))) {
      await store.updateStep(stepId, {
        status: "skipped",
        error: "Not run: the run was cancelled or taken over by another worker.",
        completedAt: now().toISOString(),
      });
      return leaseLost();
    }

    try {
      const ai = node.type === "ai" ? (node.config as unknown as AIConfig) : null;
      const result = ai
        ? await runAINode(deps.ai, {
            tenantId: run.tenantId,
            journeyId: run.journeyId,
            runId: run.id,
            nodeId: node.id,
            stepKey: keys.get(node.id) ?? node.id,
            contactId: run.contactId,
            agent: ai.agent,
            goal: ai.goal ?? "",
            instructions: ai.instructions ?? "",
            outputSchema: aiOutputSchema(ai),
            context: context(),
          })
        : action?.action === "start_journey"
          ? await startJourney(deps, run, node.id, action, (source) => resolveField(context(), resolveStepField(source, snapshot.nodes, keys)), started)
          : await deps.actions.execute(action as Exclude<ActionConfig, { action: "wait" }>, {
              tenantId: run.tenantId,
              runId: run.id,
              nodeId: node.id,
              contactId: run.contactId,
              lead: entities.lead,
              opportunity: entities.opportunity,
            });
      if (result.status === "waiting") waitFor = { runId: result.runId, output: result.output };
      else {
        const output = result.status === "skipped" ? { ...result.output, skipped_reason: result.reason } : result.output;
        outcome = { status: result.status, output, completedAt: now().toISOString() };
      }
    } catch (error) {
      const { message, kind } = classify(error);
      await store.updateStep(stepId, { status: "failed", error: message, errorKind: kind, completedAt: now().toISOString() });
      if (kind === "transient" && attempt < MAX_ATTEMPTS) {
        const delay = RETRY_BACKOFF_MS[Math.min(attempt - 1, RETRY_BACKOFF_MS.length - 1)];
        return finish("waiting", {
          currentNodeId: node.id,
          context: { ...state, attempts: { ...state.attempts, [node.id]: attempt } },
          resumeAt: new Date(now().getTime() + delay).toISOString(),
          error: message,
        });
      }
      return finish("failed", { currentNodeId: node.id, context: state, error: message });
    }

    if (waitFor) {
      // The child exists. Its step stays running until the child finishes; a pass
      // that dies before the park is written repeats the step, which finds the
      // same child by its run key.
      await store.updateStep(stepId, { output: waitFor.output });
      if (state.attempts) delete state.attempts[node.id];
      const childKey = childRunKey(run.id, node.id, (action as Extract<ActionConfig, { action: "start_journey" }>).journeyId);
      return waitForChild(
        { currentNodeId: node.id, context: { ...state, waitingForChild: { nodeId: node.id, stepId, runId: waitFor.runId } } },
        waitFor.runId,
        childKey,
      );
    }
    if (!outcome) throw new Error("Step finished without an outcome.");

    // The side effect happened. Failures from here on are bookkeeping failures: they
    // propagate and are never retried as the action. The step update or, failing that,
    // the run's in-flight outcome lets the next pass finish without repeating it.
    try {
      await store.updateStep(stepId, outcome);
    } catch (error) {
      await write({ currentNodeId, context: { ...state, inFlight: { nodeId: node.id, stepId, outcome } } }).catch(() => false);
      throw error;
    }
    recordOutput(node, outcome.output);
    if (state.attempts) delete state.attempts[node.id];
    currentNodeId = nextNodeId(snapshot, node.id);
    if (!(await persist())) return leaseLost();
    if (outcome.status === "completed" && action !== null && CHANGES_ENTITIES.has(action.action)) {
      entities = await store.loadEntities(run.tenantId, run.contactId);
    }
  }

  // A run another journey started returns its declared results, captured in the write that completes it.
  const captured =
    run.triggerEvent === "journey.started"
      ? capturedResults(snapshot, (source) => resolveField(context(), resolveStepField(source, snapshot.nodes, keys)))
      : {};
  return finish("completed", { currentNodeId: null, context: { ...state, ...captured }, error: null });
}

export interface ResumeResult {
  /** Due runs listed this batch. */
  found: number;
  /** Runs that returned an outcome (including not_claimed). */
  processed: number;
  /** Runs whose execution threw (store/infrastructure errors); other runs still ran. */
  errors: number;
  /** True when shouldContinue stopped the batch before every listed run was tried. */
  stopped: boolean;
  outcomes: Array<{ runId: string } & ExecuteOutcome>;
}

/**
 * Worker entry: runs every due run (waits finished, retries due, abandoned
 * inline runs). Listing doesn't reserve anything; each run is only executed by
 * the caller that wins its claim. `shouldContinue` is checked before each run
 * so a time-boxed caller leaves the rest for the next invocation.
 */
export async function resumeDueRuns(
  deps: EngineDeps,
  limit = 25,
  options: { shouldContinue?: () => boolean } = {},
): Promise<ResumeResult> {
  const now = deps.now ?? (() => new Date());
  const ids = await deps.store.listDueRunIds(now(), limit);
  const outcomes: Array<{ runId: string } & ExecuteOutcome> = [];
  let errors = 0;
  let stopped = false;
  for (const runId of ids) {
    if (options.shouldContinue && !options.shouldContinue()) {
      stopped = true;
      break;
    }
    try {
      outcomes.push({ runId, ...(await executeRun(deps, runId)) });
    } catch (error) {
      errors++;
      console.error("[journeys] run failed to execute:", runId, error instanceof Error ? error.message : error);
    }
  }
  return { found: ids.length, processed: outcomes.length, errors, stopped, outcomes };
}
