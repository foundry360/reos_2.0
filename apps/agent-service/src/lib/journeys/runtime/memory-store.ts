/**
 * In-memory JourneyRuntimeStore with the same semantics as the Supabase store
 * (tenant scoping, idempotency, leasing, cancelled-run protection). Used by tests.
 */

import { randomUUID } from "node:crypto";
import type { JourneyStatus } from "../journey-types.ts";
import type { TriggerEventType } from "./contracts.ts";
import type { JourneySnapshot } from "./graph.ts";
import type {
  CandidateJourney,
  CreateRunResult,
  JourneyRuntimeStore,
  LoadedEntities,
  NewRun,
  NewStep,
  RunPatch,
  RunRecord,
  RunRetryWriteResult,
  RunState,
  RunWriteResult,
  StepPatch,
} from "./engine.ts";

const ACTIVE_STATUSES: readonly string[] = ["running", "waiting", "paused"];

/**
 * The AI step (parent run + node) a run was started for, as the index of
 * migration 059 computes it: its run key without the target journey. Null
 * for any run an AI step didn't ask for.
 */
function aiStepOf(run: Pick<NewRun, "triggerEvent" | "triggerPayload" | "idempotencyKey">): string | null {
  if (run.triggerEvent !== "journey.started" || run.triggerPayload.requested_by !== "ai_step") return null;
  return run.idempotencyKey.replace(/:[^:]*$/, "");
}

export interface MemoryJourney {
  id: string;
  tenantId: string;
  status: JourneyStatus;
  version: number;
  versions: Map<number, JourneySnapshot>;
}

export interface MemoryRun extends RunRecord {
  idempotencyKey: string;
  lockedUntil: string | null;
  completedAt: string | null;
  pausedAt: string | null;
}

export interface MemoryStep extends NewStep {
  id: string;
}

export class MemoryJourneyStore implements JourneyRuntimeStore {
  journeys = new Map<string, MemoryJourney>();
  runs = new Map<string, MemoryRun>();
  steps: MemoryStep[] = [];
  contacts = new Map<string, { tenantId: string; lead: Record<string, unknown>; opportunity?: Record<string, unknown> }>();
  appointments = new Map<
    string,
    { tenantId: string; contactId: string; status: string; start: string; end: string | null }
  >();
  messages: Array<{ tenantId: string; contactId: string; direction: "inbound" | "outbound"; createdAt: string }> = [];
  /** Stands in for the database's now() default on journey_runs.started_at. */
  clock: () => Date = () => new Date();
  private seq = 0;

  private id(prefix: string) {
    this.seq++;
    return `${prefix}-${String(this.seq).padStart(4, "0")}`;
  }

  /** Mirrors save_journey_graph + snapshot_journey_version. */
  saveJourney(tenantId: string, journeyId: string, snapshot: JourneySnapshot, status: JourneyStatus = "active") {
    const existing = this.journeys.get(journeyId);
    const version = (existing?.version ?? 0) + 1;
    const versions = existing?.versions ?? new Map<number, JourneySnapshot>();
    versions.set(version, structuredClone(snapshot));
    this.journeys.set(journeyId, { id: journeyId, tenantId, status: existing?.status ?? status, version, versions });
    return version;
  }

  setStatus(journeyId: string, status: JourneyStatus) {
    const journey = this.journeys.get(journeyId);
    if (journey) journey.status = status;
  }

  async findCandidateJourneys(tenantId: string, event: TriggerEventType): Promise<CandidateJourney[]> {
    return [...this.journeys.values()]
      .filter((journey) => journey.tenantId === tenantId && journey.status === "active")
      .map((journey) => ({
        journeyId: journey.id,
        version: journey.version,
        snapshot: structuredClone(journey.versions.get(journey.version)!),
      }))
      .filter((candidate) =>
        candidate.snapshot.nodes.some((node) => node.type === "trigger" && node.config.event === event),
      );
  }

  async hasActiveRun(tenantId: string, journeyId: string, contactId: string) {
    return [...this.runs.values()].some(
      (run) =>
        run.tenantId === tenantId &&
        run.journeyId === journeyId &&
        run.contactId === contactId &&
        ACTIVE_STATUSES.includes(run.status),
    );
  }

  async createRun(input: NewRun): Promise<CreateRunResult> {
    const existing = [...this.runs.values()].find(
      (run) => run.tenantId === input.tenantId && run.idempotencyKey === input.idempotencyKey,
    );
    if (existing) return { run: structuredClone(existing), created: false };
    // Mirrors journey_runs_one_child_per_ai_step_idx (migration 059).
    const aiStep = aiStepOf(input);
    if (aiStep !== null && [...this.runs.values()].some((run) => run.tenantId === input.tenantId && aiStepOf(run) === aiStep)) {
      return { run: null, created: false, aiStepChildExists: true };
    }
    // Mirrors journey_runs_one_active_per_contact_idx (migration 056).
    const active = [...this.runs.values()].some(
      (run) =>
        input.contactId !== null &&
        run.tenantId === input.tenantId &&
        run.journeyId === input.journeyId &&
        run.contactId === input.contactId &&
        ACTIVE_STATUSES.includes(run.status),
    );
    if (active) return { run: null, created: false, alreadyActive: true };
    const run: MemoryRun = {
      // A uuid like journey_runs.id, so lineage (root_run_id) validates the same way.
      id: randomUUID(),
      tenantId: input.tenantId,
      journeyId: input.journeyId,
      journeyVersion: input.journeyVersion,
      contactId: input.contactId,
      status: "running",
      currentNodeId: input.currentNodeId,
      triggerEvent: input.triggerEvent,
      triggerPayload: input.triggerPayload,
      context: { steps: {} },
      error: null,
      resumeAt: input.resumeAt,
      startedAt: this.clock().toISOString(),
      entityType: input.entityType,
      entityId: input.entityId,
      idempotencyKey: input.idempotencyKey,
      lockedUntil: null,
      completedAt: null,
      pausedAt: null,
    };
    this.runs.set(run.id, run);
    return { run: structuredClone(run), created: true };
  }

  async claimRun(runId: string, now: Date, leaseUntil: Date) {
    const run = this.runs.get(runId);
    if (!run || !["running", "waiting"].includes(run.status)) return null;
    if (run.lockedUntil && new Date(run.lockedUntil) > now) return null;
    run.lockedUntil = leaseUntil.toISOString();
    run.status = "running";
    return { ...structuredClone(run), lease: run.lockedUntil };
  }

  async updateRun(runId: string, lease: string, patch: RunPatch): Promise<RunWriteResult> {
    const run = this.runs.get(runId);
    if (!run || run.status !== "running" || run.lockedUntil !== lease) return "lease_lost";
    for (const [key, value] of Object.entries(patch)) {
      if (value !== undefined) (run as unknown as Record<string, unknown>)[key] = structuredClone(value);
    }
    return "updated";
  }

  async retryFailedRun(
    tenantId: string,
    runId: string,
    expectedNodeId: string,
    context: RunState,
    resumeAt: string,
  ): Promise<RunRetryWriteResult> {
    const run = this.runs.get(runId);
    if (!run || run.tenantId !== tenantId || run.status !== "failed" || run.currentNodeId !== expectedNodeId) {
      return "not_failed";
    }
    // Mirrors journey_runs_one_active_per_contact_idx (migration 056).
    const active = [...this.runs.values()].some(
      (other) =>
        other.id !== run.id &&
        run.contactId !== null &&
        other.tenantId === run.tenantId &&
        other.journeyId === run.journeyId &&
        other.contactId === run.contactId &&
        ACTIVE_STATUSES.includes(other.status),
    );
    if (active) return "active_run";
    run.status = "waiting";
    run.resumeAt = resumeAt;
    run.completedAt = null;
    run.lockedUntil = null;
    run.error = null;
    run.context = structuredClone(context);
    return "retried";
  }

  async loadSnapshot(journeyId: string, version: number) {
    const snapshot = this.journeys.get(journeyId)?.versions.get(version);
    return snapshot ? structuredClone(snapshot) : null;
  }

  async journeyStatus(tenantId: string, journeyId: string) {
    const journey = this.journeys.get(journeyId);
    return journey && journey.tenantId === tenantId ? journey.status : null;
  }

  async insertStep(step: NewStep) {
    const id = this.id("step");
    this.steps.push({ ...structuredClone(step), id });
    return id;
  }

  async updateStep(stepId: string, patch: StepPatch) {
    const step = this.steps.find((entry) => entry.id === stepId);
    if (step) Object.assign(step, structuredClone(patch));
  }

  async loadStep(tenantId: string, stepId: string) {
    const step = this.steps.find((entry) => entry.id === stepId && entry.tenantId === tenantId);
    return step ? { status: step.status, output: structuredClone(step.output ?? {}) } : null;
  }

  async loadEntities(tenantId: string, contactId: string | null, appointmentId?: string | null): Promise<LoadedEntities> {
    const contact = contactId ? this.contacts.get(contactId) : undefined;
    if (!contact || contact.tenantId !== tenantId) return { lead: null, opportunity: null };
    const entities: LoadedEntities = {
      lead: structuredClone(contact.lead),
      opportunity: structuredClone(contact.opportunity ?? null),
    };
    if (appointmentId) {
      const appointment = this.appointments.get(appointmentId);
      entities.appointment =
        appointment && appointment.tenantId === tenantId && appointment.contactId === contactId
          ? { id: appointmentId, status: appointment.status, start: appointment.start, end: appointment.end }
          : null;
    }
    return entities;
  }

  async hasInboundMessageSince(tenantId: string, contactId: string, since: string) {
    const start = new Date(since).getTime();
    return this.messages.some(
      (message) =>
        message.tenantId === tenantId &&
        message.contactId === contactId &&
        message.direction === "inbound" &&
        new Date(message.createdAt).getTime() >= start,
    );
  }

  async listDueRunIds(now: Date, limit: number) {
    return [...this.runs.values()]
      .filter(
        (run) =>
          ["running", "waiting"].includes(run.status) &&
          run.resumeAt !== null &&
          new Date(run.resumeAt) <= now &&
          (!run.lockedUntil || new Date(run.lockedUntil) <= now),
      )
      .slice(0, limit)
      .map((run) => run.id);
  }

  async findRunByIdempotencyKey(tenantId: string, idempotencyKey: string) {
    const run = [...this.runs.values()].find((entry) => entry.tenantId === tenantId && entry.idempotencyKey === idempotencyKey);
    if (!run) return null;
    return {
      id: run.id,
      status: run.status,
      ...(run.context.results !== undefined ? { results: structuredClone(run.context.results) } : {}),
      ...(run.context.resultsError !== undefined ? { resultsError: structuredClone(run.context.resultsError) } : {}),
    };
  }

  async wakeWaitingParent(tenantId: string, parentRunId: string, childRunId: string, now: Date) {
    const run = this.runs.get(parentRunId);
    if (!run || run.tenantId !== tenantId || run.status !== "waiting") return;
    const waitedFor =
      run.context.waitingForChild?.runId === childRunId ||
      (Array.isArray(run.context.waitingForChildren?.children) && run.context.waitingForChildren.children.some((child) => child.runId === childRunId));
    if (!waitedFor) return;
    run.resumeAt = now.toISOString();
  }

  stepsFor(runId: string) {
    return this.steps.filter((step) => step.runId === runId);
  }
}
