import { createClient } from "@/lib/supabase/server";
import { journeyNodeTypeDefinition } from "./journey-node-types";
import {
  canTransitionJourney,
  isJourneyNodeType,
  isJourneyStatus,
  type JourneyConnection,
  type JourneyDefinition,
  type JourneyGraph,
  type JourneyNode,
  type JourneyStatus,
  type JourneySummary,
} from "./journey-types";
import { activationBlocker } from "./journey-validation";

export type RepositoryResult<T> = { ok: true; value: T } | { ok: false; error: string };

interface JourneyRow {
  id: string;
  name: string;
  description: string | null;
  status: string;
  version: number;
  created_at: string;
  updated_at: string;
}

interface NodeRow {
  id: string;
  type: string;
  name: string;
  description: string | null;
  position_x: number;
  position_y: number;
  config: Record<string, unknown> | null;
}

interface ConnectionRow {
  id: string;
  source_node_id: string;
  target_node_id: string;
  source_handle: string | null;
  target_handle: string | null;
}

const JOURNEY_COLUMNS = "id, name, description, status, version, created_at, updated_at";

function toStatus(value: string): JourneyStatus {
  return isJourneyStatus(value) ? value : "draft";
}

function toNode(row: NodeRow): JourneyNode | null {
  if (!isJourneyNodeType(row.type)) return null;
  return {
    id: row.id,
    type: row.type,
    name: row.name || journeyNodeTypeDefinition(row.type).label,
    description: row.description ?? "",
    position: { x: Number(row.position_x) || 0, y: Number(row.position_y) || 0 },
    config: row.config ?? {},
  };
}

function toConnection(row: ConnectionRow): JourneyConnection {
  return {
    id: row.id,
    sourceNodeId: row.source_node_id,
    targetNodeId: row.target_node_id,
    sourceHandle: row.source_handle,
    targetHandle: row.target_handle,
  };
}

function nodesPayload(graph: JourneyGraph) {
  return graph.nodes.map((node) => ({
    id: node.id,
    type: node.type,
    name: node.name.trim(),
    description: node.description.trim(),
    position_x: node.position.x,
    position_y: node.position.y,
    config: node.config,
  }));
}

function connectionsPayload(graph: JourneyGraph) {
  return graph.connections.map((connection) => ({
    id: connection.id,
    source_node_id: connection.sourceNodeId,
    target_node_id: connection.targetNodeId,
    source_handle: connection.sourceHandle,
    target_handle: connection.targetHandle,
    config: {},
  }));
}

function saveErrorMessage(message: string): string {
  if (message.includes("journey_version_conflict")) {
    return "This journey was changed in another window. Reload to get the latest version before saving.";
  }
  if (message.includes("journey_not_found")) return "Journey not found.";
  if (message.includes("save_journey_graph") || message.includes("journey_nodes")) {
    return "Journey storage is not set up yet. Run the journeys database migration.";
  }
  return "Could not save the journey.";
}

export async function listJourneys(tenantId: string): Promise<RepositoryResult<JourneySummary[]>> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("journeys")
    .select(`${JOURNEY_COLUMNS}, journey_nodes(count)`)
    .eq("tenant_id", tenantId)
    .order("updated_at", { ascending: false });

  if (error) {
    console.error("listJourneys failed:", error.message);
    return { ok: false, error: "Could not load journeys." };
  }

  return {
    ok: true,
    value: (data ?? []).map((row) => {
      const journey = row as JourneyRow & { journey_nodes?: Array<{ count: number }> };
      return {
        id: journey.id,
        name: journey.name,
        description: journey.description ?? "",
        status: toStatus(journey.status),
        nodeCount: journey.journey_nodes?.[0]?.count ?? 0,
        createdAt: journey.created_at,
        updatedAt: journey.updated_at,
      };
    }),
  };
}

export async function getJourneyDefinition(
  tenantId: string,
  journeyId: string,
): Promise<RepositoryResult<JourneyDefinition | null>> {
  const supabase = await createClient();
  const { data: journey, error } = await supabase
    .from("journeys")
    .select(JOURNEY_COLUMNS)
    .eq("tenant_id", tenantId)
    .eq("id", journeyId)
    .maybeSingle();

  if (error) {
    console.error("getJourneyDefinition failed:", error.message);
    return { ok: false, error: "Could not load the journey." };
  }
  if (!journey) return { ok: true, value: null };

  const [nodesRes, connectionsRes] = await Promise.all([
    supabase
      .from("journey_nodes")
      .select("id, type, name, description, position_x, position_y, config")
      .eq("journey_id", journeyId)
      .order("created_at", { ascending: true }),
    supabase
      .from("journey_connections")
      .select("id, source_node_id, target_node_id, source_handle, target_handle")
      .eq("journey_id", journeyId),
  ]);

  if (nodesRes.error || connectionsRes.error) {
    console.error(
      "getJourneyDefinition graph failed:",
      nodesRes.error?.message ?? connectionsRes.error?.message,
    );
    return { ok: false, error: "Could not load the journey canvas." };
  }

  const row = journey as JourneyRow;
  return {
    ok: true,
    value: {
      id: row.id,
      name: row.name,
      description: row.description ?? "",
      status: toStatus(row.status),
      version: row.version,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      nodes: ((nodesRes.data ?? []) as NodeRow[])
        .map(toNode)
        .filter((node): node is JourneyNode => Boolean(node)),
      connections: ((connectionsRes.data ?? []) as ConnectionRow[]).map(toConnection),
    },
  };
}

async function writeGraph(params: {
  journeyId: string;
  name: string;
  description: string;
  graph: JourneyGraph;
  expectedVersion: number | null;
  userId: string | null;
}): Promise<RepositoryResult<number>> {
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("save_journey_graph", {
    p_journey_id: params.journeyId,
    p_name: params.name,
    p_description: params.description,
    p_nodes: nodesPayload(params.graph),
    p_connections: connectionsPayload(params.graph),
    p_expected_version: params.expectedVersion,
    p_modified_by_id: params.userId,
  });

  if (error) {
    console.error("save_journey_graph failed:", error.message);
    return { ok: false, error: saveErrorMessage(error.message) };
  }
  return { ok: true, value: Number(data) };
}

export async function createJourney(params: {
  tenantId: string;
  userId: string | null;
  name: string;
  description: string;
  graph: JourneyGraph;
}): Promise<RepositoryResult<string>> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("journeys")
    .insert({
      tenant_id: params.tenantId,
      name: params.name.trim(),
      description: params.description.trim() || null,
      status: "draft",
      created_by_id: params.userId,
      last_modified_by_id: params.userId,
    })
    .select("id, version")
    .single();

  if (error || !data) {
    console.error("createJourney failed:", error?.message);
    return {
      ok: false,
      error: error?.message.includes("journeys")
        ? "Journey storage is not set up yet. Run the journeys database migration."
        : "Could not create the journey.",
    };
  }

  if (params.graph.nodes.length > 0) {
    const saved = await writeGraph({
      journeyId: data.id,
      name: params.name,
      description: params.description,
      graph: params.graph,
      expectedVersion: data.version,
      userId: params.userId,
    });
    if (!saved.ok) {
      await supabase.from("journeys").delete().eq("id", data.id);
      return saved;
    }
  }

  return { ok: true, value: data.id };
}

export async function saveJourney(params: {
  tenantId: string;
  userId: string | null;
  journeyId: string;
  name: string;
  description: string;
  graph: JourneyGraph;
  expectedVersion: number;
}): Promise<RepositoryResult<{ version: number; updatedAt: string }>> {
  const supabase = await createClient();
  const { data: owned } = await supabase
    .from("journeys")
    .select("id")
    .eq("tenant_id", params.tenantId)
    .eq("id", params.journeyId)
    .maybeSingle();
  if (!owned) return { ok: false, error: "Journey not found." };

  const saved = await writeGraph({
    journeyId: params.journeyId,
    name: params.name,
    description: params.description,
    graph: params.graph,
    expectedVersion: params.expectedVersion,
    userId: params.userId,
  });
  if (!saved.ok) return saved;

  const { data: refreshed } = await supabase
    .from("journeys")
    .select("updated_at")
    .eq("id", params.journeyId)
    .maybeSingle();

  return {
    ok: true,
    value: { version: saved.value, updatedAt: refreshed?.updated_at ?? new Date().toISOString() },
  };
}

export async function setJourneyStatus(params: {
  tenantId: string;
  userId: string | null;
  journeyId: string;
  status: JourneyStatus;
}): Promise<RepositoryResult<{ status: JourneyStatus; updatedAt: string }>> {
  const current = await getJourneyDefinition(params.tenantId, params.journeyId);
  if (!current.ok) return current;
  if (!current.value) return { ok: false, error: "Journey not found." };

  const from = current.value.status;
  if (from === params.status) {
    return { ok: true, value: { status: from, updatedAt: current.value.updatedAt } };
  }
  if (!canTransitionJourney(from, params.status)) {
    return { ok: false, error: `A ${from} journey cannot move to ${params.status}.` };
  }
  if (params.status === "active") {
    const blocker = activationBlocker(current.value);
    if (blocker) return { ok: false, error: blocker };
  }

  const supabase = await createClient();
  const { data, error } = await supabase
    .from("journeys")
    .update({
      status: params.status,
      last_modified_by_id: params.userId,
      ...(params.status === "active" ? { activated_at: new Date().toISOString() } : {}),
    })
    .eq("tenant_id", params.tenantId)
    .eq("id", params.journeyId)
    .eq("status", from)
    .select("status, updated_at")
    .maybeSingle();

  if (error || !data) {
    if (error) console.error("setJourneyStatus failed:", error.message);
    return { ok: false, error: "Could not update the journey status. Refresh and try again." };
  }
  return { ok: true, value: { status: toStatus(data.status), updatedAt: data.updated_at } };
}

export async function duplicateJourney(params: {
  tenantId: string;
  userId: string | null;
  journeyId: string;
  newId: () => string;
}): Promise<RepositoryResult<string>> {
  const source = await getJourneyDefinition(params.tenantId, params.journeyId);
  if (!source.ok) return source;
  if (!source.value) return { ok: false, error: "Journey not found." };

  const idMap = new Map(source.value.nodes.map((node) => [node.id, params.newId()]));
  const graph: JourneyGraph = {
    nodes: source.value.nodes.map((node) => ({ ...node, id: idMap.get(node.id)! })),
    connections: source.value.connections.flatMap((connection) => {
      const sourceNodeId = idMap.get(connection.sourceNodeId);
      const targetNodeId = idMap.get(connection.targetNodeId);
      if (!sourceNodeId || !targetNodeId) return [];
      return [{ ...connection, id: params.newId(), sourceNodeId, targetNodeId }];
    }),
  };

  return createJourney({
    tenantId: params.tenantId,
    userId: params.userId,
    name: `Copy of ${source.value.name}`.slice(0, 120),
    description: source.value.description,
    graph,
  });
}

export async function deleteJourney(
  tenantId: string,
  journeyId: string,
): Promise<RepositoryResult<null>> {
  const supabase = await createClient();
  const { error, count } = await supabase
    .from("journeys")
    .delete({ count: "exact" })
    .eq("tenant_id", tenantId)
    .eq("id", journeyId);

  if (error) {
    console.error("deleteJourney failed:", error.message);
    return { ok: false, error: "Could not delete the journey." };
  }
  if (!count) return { ok: false, error: "Journey not found." };
  return { ok: true, value: null };
}
