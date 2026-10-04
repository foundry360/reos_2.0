/**
 * Graph traversal and activation validation for executable journeys.
 *
 * Branching convention (shared with the builder): a condition node's outgoing
 * connection stores its branch in source_handle — CONDITION_HANDLES.yes ("yes")
 * when the condition is true, CONDITION_HANDLES.no ("no") when false. A
 * condition connection with no handle (saved before handles existed) is the Yes
 * path. Every other node has a single outgoing connection and no handle.
 */

import {
  CONDITION_HANDLES,
  type JourneyConnection,
  type JourneyGraph,
  type JourneyNode,
} from "../journey-types.ts";
import { stepKey, validateNodeConfig } from "./contracts.ts";

export interface SnapshotNode {
  id: string;
  type: JourneyNode["type"];
  name: string;
  description: string;
  config: Record<string, unknown>;
}

export interface JourneySnapshot {
  nodes: SnapshotNode[];
  connections: JourneyConnection[];
}

export function branchOf(connection: Pick<JourneyConnection, "sourceHandle">): "yes" | "no" {
  return connection.sourceHandle === CONDITION_HANDLES.no ? "no" : "yes";
}

/** The node that follows `nodeId`; for a condition, the node on the chosen branch. */
export function nextNodeId(
  snapshot: JourneySnapshot,
  nodeId: string,
  branch?: boolean,
): string | null {
  const node = snapshot.nodes.find((entry) => entry.id === nodeId);
  if (!node) return null;
  const outgoing = snapshot.connections.filter((connection) => connection.sourceNodeId === nodeId);
  if (node.type === "condition") {
    const wanted = branch ? "yes" : "no";
    return outgoing.find((connection) => branchOf(connection) === wanted)?.targetNodeId ?? null;
  }
  return outgoing[0]?.targetNodeId ?? null;
}

export function triggerNodes<T extends Pick<SnapshotNode, "type">>(snapshot: { nodes: T[] }): T[] {
  return snapshot.nodes.filter((node) => node.type === "trigger");
}

/** Keys used for steps.<key>.output.<field>; duplicates get a numeric suffix. */
export function stepKeys(nodes: Pick<SnapshotNode, "id" | "name">[]): Map<string, string> {
  const keys = new Map<string, string>();
  const used = new Set<string>();
  for (const node of nodes) {
    const base = stepKey(node.name, node.id);
    let key = base;
    for (let n = 2; used.has(key); n++) key = `${base}_${n}`;
    used.add(key);
    keys.set(node.id, key);
  }
  return keys;
}

export interface ActivationIssue {
  nodeId: string | null;
  message: string;
}

function label(node: Pick<SnapshotNode, "name" | "type">): string {
  return `"${node.name.trim() || node.type}"`;
}

/**
 * Everything that must hold before a journey can run. Returns every problem so
 * the builder can show them together.
 */
export function activationIssues(graph: JourneyGraph | JourneySnapshot): ActivationIssue[] {
  const issues: ActivationIssue[] = [];
  const nodes = graph.nodes;
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const triggers = nodes.filter((node) => node.type === "trigger");

  if (triggers.length === 0) {
    issues.push({ nodeId: null, message: "Add a Trigger node before activating this journey." });
    return issues;
  }

  for (const node of nodes) {
    const { errors } = validateNodeConfig(node.type, node.config, "strict");
    for (const error of errors) issues.push({ nodeId: node.id, message: `${label(node)}: ${error}` });
  }

  const outgoing = new Map<string, JourneyConnection[]>();
  for (const connection of graph.connections) {
    if (!byId.has(connection.sourceNodeId) || !byId.has(connection.targetNodeId)) {
      issues.push({ nodeId: null, message: "A connection points to a node that no longer exists." });
      continue;
    }
    const list = outgoing.get(connection.sourceNodeId) ?? [];
    list.push(connection);
    outgoing.set(connection.sourceNodeId, list);
  }

  for (const node of nodes) {
    const out = outgoing.get(node.id) ?? [];
    if (node.type === "trigger" && out.length === 0) {
      issues.push({ nodeId: node.id, message: `${label(node)} isn't connected to a next step.` });
    }
    if (node.type === "condition") {
      const yes = out.filter((connection) => branchOf(connection) === "yes");
      const no = out.filter((connection) => branchOf(connection) === "no");
      if (yes.length === 0 && no.length === 0) {
        issues.push({ nodeId: node.id, message: `${label(node)} needs a Yes or No path.` });
      }
      if (yes.length > 1 || no.length > 1) {
        issues.push({ nodeId: node.id, message: `${label(node)} has more than one connection on the same path.` });
      }
    } else if (out.length > 1) {
      issues.push({
        nodeId: node.id,
        message: `${label(node)} connects to more than one step. Only conditions can branch.`,
      });
    }
  }

  const reachable = new Set<string>();
  const queue = triggers.map((node) => node.id);
  while (queue.length > 0) {
    const id = queue.shift()!;
    if (reachable.has(id)) continue;
    reachable.add(id);
    for (const connection of outgoing.get(id) ?? []) queue.push(connection.targetNodeId);
  }
  for (const node of nodes) {
    if (!reachable.has(node.id)) {
      issues.push({ nodeId: node.id, message: `${label(node)} isn't reachable from a trigger.` });
    }
  }

  // Cycle detection: depth-first with an on-stack set.
  const state = new Map<string, "visiting" | "done">();
  let cycleAt: string | null = null;
  const visit = (id: string): void => {
    if (cycleAt) return;
    state.set(id, "visiting");
    for (const connection of outgoing.get(id) ?? []) {
      const status = state.get(connection.targetNodeId);
      if (status === "visiting") {
        cycleAt = connection.targetNodeId;
        return;
      }
      if (!status) visit(connection.targetNodeId);
      if (cycleAt) return;
    }
    state.set(id, "done");
  };
  for (const node of nodes) if (!state.has(node.id)) visit(node.id);
  if (cycleAt) {
    const node = byId.get(cycleAt);
    issues.push({
      nodeId: cycleAt,
      message: `The journey loops back to ${node ? label(node) : "an earlier step"}. Loops aren't supported.`,
    });
  }

  return issues;
}
