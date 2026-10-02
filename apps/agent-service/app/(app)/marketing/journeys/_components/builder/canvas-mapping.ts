import type { Edge, Node } from "@xyflow/react";
import type {
  JourneyGraph,
  JourneyNodeConfig,
  JourneyNodeType,
} from "@/lib/journeys/journey-types";

/** React Flow keeps canvas state; the journey model is derived from it on save. */
export type JourneyNodeData = {
  nodeType: JourneyNodeType;
  name: string;
  description: string;
  config: JourneyNodeConfig;
};

export type JourneyFlowNode = Node<JourneyNodeData, "journey">;
export type JourneyFlowEdge = Edge;

export function toFlowNodes(graph: JourneyGraph): JourneyFlowNode[] {
  return graph.nodes.map((node) => ({
    id: node.id,
    type: "journey",
    position: { ...node.position },
    data: {
      nodeType: node.type,
      name: node.name,
      description: node.description,
      config: node.config,
    },
  }));
}

export function toFlowEdges(graph: JourneyGraph): JourneyFlowEdge[] {
  return graph.connections.map((connection) => ({
    id: connection.id,
    source: connection.sourceNodeId,
    target: connection.targetNodeId,
    sourceHandle: connection.sourceHandle,
    targetHandle: connection.targetHandle,
  }));
}

export function toJourneyGraph(nodes: JourneyFlowNode[], edges: JourneyFlowEdge[]): JourneyGraph {
  return {
    nodes: nodes.map((node) => ({
      id: node.id,
      type: node.data.nodeType,
      name: node.data.name,
      description: node.data.description,
      position: { x: Math.round(node.position.x), y: Math.round(node.position.y) },
      config: node.data.config,
    })),
    connections: edges.map((edge) => ({
      id: edge.id,
      sourceNodeId: edge.source,
      targetNodeId: edge.target,
      sourceHandle: edge.sourceHandle ?? null,
      targetHandle: edge.targetHandle ?? null,
    })),
  };
}
