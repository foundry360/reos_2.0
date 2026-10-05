import type { SupabaseClient } from "@supabase/supabase-js";
import { isJourneyNodeType, isJourneyStatus, type JourneyConnection } from "@/lib/journeys/journey-types";
import { validateNodeConfig, type TriggerEventType } from "./contracts";
import type { JourneySnapshot, SnapshotNode } from "./graph";
import type {
  CandidateJourney,
  JourneyRuntimeStore,
  LoadedEntities,
  NewRun,
  NewStep,
  RunPatch,
  RunRecord,
  RunState,
  StepPatch,
} from "./engine";

const RUN_COLUMNS =
  "id, tenant_id, journey_id, journey_version, contact_id, status, current_node_id, trigger_event, trigger_payload, context, error, resume_at, started_at";

const LEAD_COLUMNS =
  "id, first_name, last_name, email, lead_status, lead_temperature, intent, qualification_score, ready_to_book, appt_booked, handoff, opted_out, assigned_agent_id, record_type, target_location, property_type, budget, timeline, financing_status";

type RunRow = {
  id: string;
  tenant_id: string;
  journey_id: string;
  journey_version: number;
  contact_id: string | null;
  status: RunRecord["status"];
  current_node_id: string | null;
  trigger_event: string;
  trigger_payload: Record<string, unknown> | null;
  context: RunState | null;
  error: string | null;
  resume_at: string | null;
  started_at: string;
};

function toRun(row: RunRow): RunRecord {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    journeyId: row.journey_id,
    journeyVersion: row.journey_version,
    contactId: row.contact_id,
    status: row.status,
    currentNodeId: row.current_node_id,
    triggerEvent: row.trigger_event,
    triggerPayload: row.trigger_payload ?? {},
    context: { steps: {}, ...(row.context ?? {}) },
    error: row.error,
    resumeAt: row.resume_at,
    startedAt: row.started_at,
  };
}

/** Normalizes a stored snapshot; configs are re-parsed so the engine never sees unexpected shapes. */
export function parseSnapshot(graph: unknown): JourneySnapshot | null {
  if (!graph || typeof graph !== "object") return null;
  const raw = graph as { nodes?: unknown; connections?: unknown };
  if (!Array.isArray(raw.nodes) || !Array.isArray(raw.connections)) return null;
  const nodes: SnapshotNode[] = [];
  for (const entry of raw.nodes as Array<Record<string, unknown>>) {
    if (!entry || typeof entry.id !== "string" || !isJourneyNodeType(entry.type)) continue;
    nodes.push({
      id: entry.id,
      type: entry.type,
      name: typeof entry.name === "string" ? entry.name : "",
      description: typeof entry.description === "string" ? entry.description : "",
      config: validateNodeConfig(entry.type, entry.config, "draft").config,
    });
  }
  const connections: JourneyConnection[] = [];
  for (const entry of raw.connections as Array<Record<string, unknown>>) {
    if (!entry || typeof entry.sourceNodeId !== "string" || typeof entry.targetNodeId !== "string") continue;
    connections.push({
      id: String(entry.id ?? ""),
      sourceNodeId: entry.sourceNodeId,
      targetNodeId: entry.targetNodeId,
      sourceHandle: typeof entry.sourceHandle === "string" ? entry.sourceHandle : null,
      targetHandle: typeof entry.targetHandle === "string" ? entry.targetHandle : null,
    });
  }
  return { nodes, connections };
}

function runPatchRow(patch: RunPatch): Record<string, unknown> {
  const row: Record<string, unknown> = {};
  if (patch.status !== undefined) row.status = patch.status;
  if (patch.currentNodeId !== undefined) row.current_node_id = patch.currentNodeId;
  if (patch.context !== undefined) row.context = patch.context;
  if (patch.error !== undefined) row.error = patch.error;
  if (patch.resumeAt !== undefined) row.resume_at = patch.resumeAt;
  if (patch.completedAt !== undefined) row.completed_at = patch.completedAt;
  if (patch.pausedAt !== undefined) row.paused_at = patch.pausedAt;
  if (patch.lockedUntil !== undefined) row.locked_until = patch.lockedUntil;
  return row;
}

function fail(operation: string, error: { message: string } | null): never {
  throw new Error(`Journey store ${operation} failed: ${error?.message ?? "unknown error"}`);
}

/**
 * Service-role store. Runs and steps are only ever written by the server; every
 * query is explicitly scoped by tenant or by a run id that was loaded by tenant.
 */
export function createSupabaseJourneyStore(db: SupabaseClient): JourneyRuntimeStore {
  return {
    async findCandidateJourneys(tenantId: string, event: TriggerEventType): Promise<CandidateJourney[]> {
      const { data: journeys, error } = await db
        .from("journeys")
        .select("id, version")
        .eq("tenant_id", tenantId)
        .eq("status", "active");
      if (error) fail("findCandidateJourneys", error);
      if (!journeys?.length) return [];

      const currentVersion = new Map(journeys.map((row) => [row.id as string, row.version as number]));
      const { data: versions, error: versionError } = await db
        .from("journey_versions")
        .select("id, journey_id, version")
        .eq("tenant_id", tenantId)
        .contains("trigger_events", [event])
        .in("journey_id", [...currentVersion.keys()]);
      if (versionError) fail("findCandidateJourneys", versionError);

      const current = (versions ?? []).filter((row) => currentVersion.get(row.journey_id) === row.version);
      if (current.length === 0) return [];

      const { data: graphs, error: graphError } = await db
        .from("journey_versions")
        .select("journey_id, version, graph")
        .eq("tenant_id", tenantId)
        .in("id", current.map((row) => row.id));
      if (graphError) fail("findCandidateJourneys", graphError);

      return (graphs ?? []).flatMap((row) => {
        const snapshot = parseSnapshot(row.graph);
        return snapshot ? [{ journeyId: row.journey_id as string, version: row.version as number, snapshot }] : [];
      });
    },

    async hasActiveRun(tenantId, journeyId, contactId) {
      const { count, error } = await db
        .from("journey_runs")
        .select("id", { count: "exact", head: true })
        .eq("tenant_id", tenantId)
        .eq("journey_id", journeyId)
        .eq("contact_id", contactId)
        .in("status", ["running", "waiting", "paused"]);
      if (error) fail("hasActiveRun", error);
      return (count ?? 0) > 0;
    },

    async createRun(run: NewRun) {
      const { data, error } = await db
        .from("journey_runs")
        .insert({
          tenant_id: run.tenantId,
          journey_id: run.journeyId,
          journey_version: run.journeyVersion,
          contact_id: run.contactId,
          entity_type: run.entityType,
          entity_id: run.entityId,
          status: "running",
          current_node_id: run.currentNodeId,
          trigger_event: run.triggerEvent,
          trigger_payload: run.triggerPayload,
          idempotency_key: run.idempotencyKey,
          context: { steps: {} },
          resume_at: run.resumeAt,
        })
        .select(RUN_COLUMNS)
        .single();
      if (!error && data) return { run: toRun(data as RunRow), created: true };
      if (error?.code !== "23505") fail("createRun", error);

      const { data: existing, error: existingError } = await db
        .from("journey_runs")
        .select(RUN_COLUMNS)
        .eq("tenant_id", run.tenantId)
        .eq("idempotency_key", run.idempotencyKey)
        .single();
      if (existingError || !existing) fail("createRun", existingError);
      return { run: toRun(existing as RunRow), created: false };
    },

    async claimRun(runId, now, leaseUntil) {
      const { data, error } = await db
        .from("journey_runs")
        .update({ status: "running", locked_until: leaseUntil.toISOString() })
        .eq("id", runId)
        .in("status", ["running", "waiting"])
        .or(`locked_until.is.null,locked_until.lt."${now.toISOString()}"`)
        .select(RUN_COLUMNS)
        .maybeSingle();
      if (error) fail("claimRun", error);
      return data ? { ...toRun(data as RunRow), lease: leaseUntil.toISOString() } : null;
    },

    async updateRun(runId, lease, patch) {
      const { data, error } = await db
        .from("journey_runs")
        .update(runPatchRow(patch))
        .eq("id", runId)
        .eq("status", "running")
        .eq("locked_until", lease)
        .select("id");
      if (error) fail("updateRun", error);
      return data && data.length > 0 ? "updated" : "lease_lost";
    },

    async loadSnapshot(journeyId, version) {
      const { data, error } = await db
        .from("journey_versions")
        .select("graph")
        .eq("journey_id", journeyId)
        .eq("version", version)
        .maybeSingle();
      if (error) fail("loadSnapshot", error);
      return data ? parseSnapshot(data.graph) : null;
    },

    async journeyStatus(tenantId, journeyId) {
      const { data, error } = await db
        .from("journeys")
        .select("status")
        .eq("id", journeyId)
        .eq("tenant_id", tenantId)
        .maybeSingle();
      if (error) fail("journeyStatus", error);
      return data && isJourneyStatus(data.status) ? data.status : null;
    },

    async insertStep(step: NewStep) {
      const { data, error } = await db
        .from("journey_run_steps")
        .insert({
          tenant_id: step.tenantId,
          run_id: step.runId,
          node_id: step.nodeId,
          node_type: step.nodeType,
          node_name: step.nodeName,
          status: step.status,
          input: step.input,
          output: step.output ?? {},
          error: step.error ?? null,
          error_kind: step.errorKind ?? null,
          attempt_count: step.attemptCount ?? 1,
          completed_at: step.completedAt ?? null,
        })
        .select("id")
        .single();
      if (error || !data) fail("insertStep", error);
      return data.id as string;
    },

    async updateStep(stepId, patch: StepPatch) {
      const row: Record<string, unknown> = {};
      if (patch.status !== undefined) row.status = patch.status;
      if (patch.output !== undefined) row.output = patch.output;
      if (patch.error !== undefined) row.error = patch.error;
      if (patch.errorKind !== undefined) row.error_kind = patch.errorKind;
      if (patch.completedAt !== undefined) row.completed_at = patch.completedAt;
      const { error } = await db.from("journey_run_steps").update(row).eq("id", stepId);
      if (error) fail("updateStep", error);
    },

    async loadEntities(tenantId, contactId): Promise<LoadedEntities> {
      if (!contactId) return { lead: null, opportunity: null };
      const [{ data: lead, error }, { data: phone }, { data: opportunity }] = await Promise.all([
        db.from("contacts").select(LEAD_COLUMNS).eq("id", contactId).eq("tenant_id", tenantId).maybeSingle(),
        db
          .from("contact_identities")
          .select("id")
          .eq("contact_id", contactId)
          .eq("channel", "sms")
          .limit(1)
          .maybeSingle(),
        db
          .from("opportunities")
          .select("id, stage, assigned_agent_id")
          .eq("tenant_id", tenantId)
          .eq("contact_id", contactId)
          .order("created_at", { ascending: false })
          .limit(1)
          .maybeSingle(),
      ]);
      if (error) fail("loadEntities", error);
      if (!lead) return { lead: null, opportunity: null };
      return {
        lead: { ...(lead as Record<string, unknown>), has_phone: Boolean(phone) },
        opportunity: (opportunity as Record<string, unknown> | null) ?? null,
      };
    },

    async hasInboundMessageSince(tenantId, contactId, since) {
      const { data, error } = await db
        .from("messages")
        .select("id")
        .eq("tenant_id", tenantId)
        .eq("contact_id", contactId)
        .eq("direction", "inbound")
        .gte("created_at", since)
        .limit(1);
      if (error) fail("hasInboundMessageSince", error);
      return (data?.length ?? 0) > 0;
    },

    async listDueRunIds(now, limit) {
      const iso = now.toISOString();
      const { data, error } = await db
        .from("journey_runs")
        .select("id")
        .in("status", ["running", "waiting"])
        .lte("resume_at", iso)
        .or(`locked_until.is.null,locked_until.lt."${iso}"`)
        .order("resume_at", { ascending: true })
        .limit(limit);
      if (error) fail("listDueRunIds", error);
      return (data ?? []).map((row) => row.id as string);
    },
  };
}
