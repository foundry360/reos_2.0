/**
 * In-memory JourneyRuntimeStore with the same semantics as the Supabase store
 * (tenant scoping, idempotency, leasing, cancelled-run protection). Used by tests.
 */

import type { JourneyStatus } from "../journey-types.ts";
import type { TriggerEventType } from "./contracts.ts";
import type { JourneySnapshot } from "./graph.ts";
import type {
  CandidateJourney,
  JourneyRuntimeStore,
  LoadedEntities,
  NewRun,
  NewStep,
  RunPatch,
  RunRecord,
  RunWriteResult,
  StepPatch,
} from "./engine.ts";

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
        ["running", "waiting", "paused"].includes(run.status),
    );
  }

  async createRun(input: NewRun) {
    const existing = [...this.runs.values()].find(
      (run) => run.tenantId === input.tenantId && run.idempotencyKey === input.idempotencyKey,
    );
    if (existing) return { run: structuredClone(existing), created: false };
    const run: MemoryRun = {
      id: this.id("run"),
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
