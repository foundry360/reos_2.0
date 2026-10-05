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

  async loadEntities(tenantId: string, contactId: string | null): Promise<LoadedEntities> {
    const contact = contactId ? this.contacts.get(contactId) : undefined;
    if (!contact || contact.tenantId !== tenantId) return { lead: null, opportunity: null };
    return { lead: structuredClone(contact.lead), opportunity: structuredClone(contact.opportunity ?? null) };
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

  stepsFor(runId: string) {
    return this.steps.filter((step) => step.runId === runId);
  }
}
