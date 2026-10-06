import { journeyNodeTypeDefinition } from "./journey-node-types";
import { activationIssues } from "./runtime/graph";
import {
  connectionLabel,
  isJourneyNodeType,
  type JourneyConnection,
  type JourneyGraph,
} from "./journey-types";

export const JOURNEY_NAME_MAX = 120;
export const JOURNEY_DESCRIPTION_MAX = 1000;
export const JOURNEY_NODE_NAME_MAX = 80;
export const JOURNEY_NODE_DESCRIPTION_MAX = 500;
export const JOURNEY_MAX_NODES = 200;

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function validateJourneyName(name: string): string | null {
  const trimmed = name.trim();
  if (!trimmed) return "Journey name is required.";
  if (trimmed.length > JOURNEY_NAME_MAX) {
    return `Journey name must be ${JOURNEY_NAME_MAX} characters or fewer.`;
  }
  return null;
}

export function validateJourneyDescription(description: string): string | null {
  if (description.trim().length > JOURNEY_DESCRIPTION_MAX) {
    return `Description must be ${JOURNEY_DESCRIPTION_MAX} characters or fewer.`;
  }
  return null;
}

/**
 * Structural checks for a single proposed connection. Intentionally minimal:
 * blocks only links that can never make sense in a journey.
 */
export function connectionRejectionReason(
  graph: JourneyGraph,
  connection: Pick<JourneyConnection, "sourceNodeId" | "targetNodeId"> &
    Partial<Pick<JourneyConnection, "sourceHandle">>,
): string | null {
  const { sourceNodeId, targetNodeId, sourceHandle } = connection;
  if (sourceNodeId === targetNodeId) return "A node cannot connect to itself.";

  const source = graph.nodes.find((node) => node.id === sourceNodeId);
  const target = graph.nodes.find((node) => node.id === targetNodeId);
  if (!source || !target) return "Both nodes must exist on the canvas.";

  if (!journeyNodeTypeDefinition(source.type).acceptsOutgoing) {
    return `${journeyNodeTypeDefinition(source.type).label} nodes cannot start a connection.`;
  }
  if (!journeyNodeTypeDefinition(target.type).acceptsIncoming) {
    return "Triggers start a journey and cannot have incoming connections.";
  }

  const duplicate = graph.connections.some(
    (existing) =>
      existing.sourceNodeId === sourceNodeId && existing.targetNodeId === targetNodeId,
  );
  if (duplicate) return "These nodes are already connected.";

  if (source.type === "condition" && sourceHandle) {
    const branchTaken = graph.connections.some(
      (existing) => existing.sourceNodeId === sourceNodeId && existing.sourceHandle === sourceHandle,
    );
    if (branchTaken) return `The ${connectionLabel(sourceHandle) ?? sourceHandle} path is already connected.`;
  }

  return null;
}

/** Validates a full graph before it is persisted. Returns the first problem found. */
export function validateJourneyGraph(graph: JourneyGraph): string | null {
  if (graph.nodes.length > JOURNEY_MAX_NODES) {
    return `A journey can have at most ${JOURNEY_MAX_NODES} nodes.`;
  }

  const nodeIds = new Set<string>();
  for (const node of graph.nodes) {
    if (!UUID_PATTERN.test(node.id)) return "A node has an invalid id.";
    if (nodeIds.has(node.id)) return "Two nodes share the same id.";
    nodeIds.add(node.id);
    if (!isJourneyNodeType(node.type)) return "A node has an unknown type.";
    if (!node.name.trim()) return "Every node needs a name.";
    if (node.name.trim().length > JOURNEY_NODE_NAME_MAX) {
      return `Node names must be ${JOURNEY_NODE_NAME_MAX} characters or fewer.`;
    }
    if (node.description.trim().length > JOURNEY_NODE_DESCRIPTION_MAX) {
      return `Node descriptions must be ${JOURNEY_NODE_DESCRIPTION_MAX} characters or fewer.`;
    }
    if (!Number.isFinite(node.position.x) || !Number.isFinite(node.position.y)) {
      return "A node has an invalid position.";
    }
  }

  const accepted: JourneyConnection[] = [];
  for (const connection of graph.connections) {
    if (!UUID_PATTERN.test(connection.id)) return "A connection has an invalid id.";
    const reason = connectionRejectionReason(
      { nodes: graph.nodes, connections: accepted },
      connection,
    );
    if (reason) return reason;
    accepted.push(connection);
  }

  return null;
}

/**
 * Everything that must hold before a journey can run (valid node configs, a
 * reachable path from a trigger, branches only on conditions, no loops).
 * Returns a single message listing the first few problems.
 */
export function activationBlocker(
  graph: JourneyGraph,
  journeyId?: string,
  declaredResults?: ReadonlyMap<string, readonly string[]>,
): string | null {
  const issues = activationIssues(graph, journeyId, declaredResults);
  if (issues.length === 0) return null;
  const shown = issues.slice(0, 3).map((issue) => issue.message);
  const more = issues.length > shown.length ? ` (+${issues.length - shown.length} more)` : "";
  return `${shown.join(" ")}${more}`;
}
