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
  LEAD_REPLIED_FIELD,
  waitMilliseconds,
  type ActionConfig,
  type AIConfig,
  type ConditionRule,
  type TriggerConfig,
  type TriggerEventType,
} from "./contracts.ts";
import { evaluateAll, evaluateCondition, type ExecutionContext } from "./conditions.ts";
import {
  nextNodeId,
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
  /** Attempts made so far for the node being retried. */
  attempts?: Record<string, number>;
  /** Set while a side-effecting step executes; still set on resume means the process died mid-step. */
  inFlight?: { nodeId: string; stepId: string };
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
  /** Inserts unless (tenant, idempotencyKey) exists. */
  createRun(run: NewRun): Promise<{ run: RunRecord; created: boolean }>;
  /** Atomically leases a running/waiting run that isn't leased; marks it running. */
  claimRun(runId: string, now: Date, leaseUntil: Date): Promise<ClaimedRun | null>;
  /**
   * Applies the patch only while the run is still running under `lease` (the
   * locked_until value this worker last wrote). Returns "lease_lost" when the
   * run was cancelled or re-claimed; throws on database errors.
   */
  updateRun(runId: string, lease: string, patch: RunPatch): Promise<RunWriteResult>;
  loadSnapshot(journeyId: string, version: number): Promise<JourneySnapshot | null>;
  journeyStatus(tenantId: string, journeyId: string): Promise<JourneyStatus | null>;
  insertStep(step: NewStep): Promise<string>;
  updateStep(stepId: string, patch: StepPatch): Promise<void>;
  loadEntities(tenantId: string, contactId: string | null): Promise<LoadedEntities>;
  /** Whether the contact sent any inbound message at or after `since`. */
  hasInboundMessageSince(tenantId: string, contactId: string, since: string): Promise<boolean>;
  listDueRunIds(now: Date, limit: number): Promise<string[]>;
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
 * Longest chain of journey runs linked by status changes. A run started by any
 * event other than a journey-made status change is depth 1; a run started by a
 * status change that a depth-N run made is depth N + 1. No run deeper than this starts.
 */
export const MAX_JOURNEY_CAUSATION_DEPTH = 3;

/** Steps that can safely run twice if the process died mid-step. */
const SAFE_TO_REPEAT = new Set(["update_lead", "assign_lead"]);

/** Actions that change lead or opportunity data later steps read, so the pass reloads it after they succeed. */
const CHANGES_ENTITIES = new Set(["update_lead", "assign_lead"]);

/**
 * Events redelivered by an outbox until acknowledged. Their run key leaves out
 * the journey version, so one event starts a journey at most once even if the
 * journey was saved (new version) between deliveries.
 */
const ONCE_PER_JOURNEY_EVENTS = new Set<string>(["lead.status_changed"]);

export function idempotencyKey(event: Pick<JourneyEvent, "type" | "sourceId">, journeyId: string, version: number) {
  const key = `${event.type}:${event.sourceId}:${journeyId}`;
  return ONCE_PER_JOURNEY_EVENTS.has(event.type) ? key : `${key}:v${version}`;
}

/** A failed AI result becomes a step error so the normal retry/fail path handles it. */
async function runAINode(executor: JourneyAIExecutor, request: JourneyAIRequest): Promise<ActionResult> {
  const result = await executor.execute(request);
  if (!result.success) throw new JourneyStepError(result.error, result.retryable ? "transient" : "config");
  return { status: "completed", output: journeyAIStepOutput(result) };
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
 * evaluated here against freshly loaded CRM data.
 */
export async function dispatchJourneyEvent(deps: EngineDeps, event: JourneyEvent): Promise<DispatchOutcome[]> {
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

    const { run, created } = await deps.store.createRun({
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

    if (!created) {
      outcomes.push({ journeyId: candidate.journeyId, version: candidate.version, runId: run.id, result: "duplicate" });
      continue;
    }
    const execution = await executeRun(deps, run.id);
    outcomes.push({ journeyId: candidate.journeyId, version: candidate.version, runId: run.id, result: "started", execution });
  }
  return outcomes;
}

// ---------- Execution ----------

export interface ExecuteOutcome {
  /** "lease_lost": the run was cancelled or another worker took it over; this pass stopped. */
  status: RunStatus | "not_claimed" | "lease_lost";
  steps: number;
}

/**
 * Runs one leased pass over a run. Safe to call concurrently: only one caller
 * wins the lease. Every run write renews the lease and succeeds only while
 * this worker still holds it, so the pass stops at the next step boundary
 * once the run is cancelled or re-claimed, before any further side effect.
 */
export async function executeRun(deps: EngineDeps, runId: string): Promise<ExecuteOutcome> {
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
    return written ? { status, steps: executed } : leaseLost();
  };

  const journeyStatus = await store.journeyStatus(run.tenantId, run.journeyId);
  if (journeyStatus === null) return finish("cancelled", { error: "The journey was deleted." });
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

  // The previous pass died while a side effect was executing.
  if (run.context.inFlight) {
    const { nodeId, stepId } = run.context.inFlight;
    const node = snapshot.nodes.find((entry) => entry.id === nodeId);
    const action = node?.type === "action" ? String(node.config.action ?? "") : "";
    if (!SAFE_TO_REPEAT.has(action) && node?.type !== "ai") {
      const message = "The step was interrupted and may or may not have completed, so it wasn't retried.";
      await store.updateStep(stepId, { status: "failed", error: message, errorKind: "config", completedAt: now().toISOString() });
      return finish("failed", { error: message, context: state, currentNodeId: nodeId });
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
      const rule = node.config as unknown as ConditionRule;
      const resolved = resolveStepReference(rule, snapshot.nodes, keys);
      const conditionContext = context();
      // Checked when the condition runs, so a reply that arrived during a wait counts.
      if (resolved.field === LEAD_REPLIED_FIELD && run.contactId && conditionContext.lead) {
        const replied = await store.hasInboundMessageSince(run.tenantId, run.contactId, run.startedAt);
        conditionContext.lead = { ...conditionContext.lead, [LEAD_REPLIED_FIELD.slice("lead.".length)]: replied };
      }
      const result = evaluateCondition(resolved, conditionContext);
      const output = { result, branch: result ? "yes" : "no" };
      await store.insertStep({ ...base, status: "completed", input: { ...rule }, output, completedAt: startedAt });
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
    let entitiesChanged = false;
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
        : await deps.actions.execute(action as Exclude<ActionConfig, { action: "wait" }>, {
            tenantId: run.tenantId,
            runId: run.id,
            nodeId: node.id,
            contactId: run.contactId,
            lead: entities.lead,
            opportunity: entities.opportunity,
          });
      const output = result.status === "skipped" ? { ...result.output, skipped_reason: result.reason } : result.output;
      await store.updateStep(stepId, { status: result.status, output, completedAt: now().toISOString() });
      recordOutput(node, output);
      if (state.attempts) delete state.attempts[node.id];
      currentNodeId = nextNodeId(snapshot, node.id);
      if (!(await persist())) return leaseLost();
      entitiesChanged = result.status === "completed" && action !== null && CHANGES_ENTITIES.has(action.action);
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
    // Outside the try: the step is already recorded and the run advanced, so a failed reload must not retry it.
    if (entitiesChanged) entities = await store.loadEntities(run.tenantId, run.contactId);
  }

  return finish("completed", { currentNodeId: null, context: state, error: null });
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
