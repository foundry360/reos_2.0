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
import {
  AI_TEXT_KEY,
  aiOutputSchema,
  conditionRules,
  nodeReferenceKey,
  STEP_FIELD_PATTERN,
  stepKey,
  validateNodeConfig,
  type AIConfig,
  type ConditionRule,
} from "./contracts.ts";

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

type GraphShape = {
  nodes: Pick<SnapshotNode, "id" | "type">[];
  connections: Pick<JourneyConnection, "sourceNodeId" | "targetNodeId">[];
};

/**
 * Nodes that run before `targetId` on every path from any trigger: removing
 * one makes the target unreachable. Ancestors that only run on some paths
 * (one side of a branch, a different trigger) are excluded. Empty when the
 * target itself is unreachable.
 */
export function guaranteedPredecessors(graph: GraphShape, targetId: string): Set<string> {
  const ids = new Set(graph.nodes.map((node) => node.id));
  const outgoing = new Map<string, string[]>();
  for (const connection of graph.connections) {
    if (!ids.has(connection.sourceNodeId) || !ids.has(connection.targetNodeId)) continue;
    const list = outgoing.get(connection.sourceNodeId) ?? [];
    list.push(connection.targetNodeId);
    outgoing.set(connection.sourceNodeId, list);
  }
  const triggers = graph.nodes.filter((node) => node.type === "trigger").map((node) => node.id);

  const reachesTarget = (without: string | null): boolean => {
    const seen = new Set<string>();
    const queue = triggers.filter((id) => id !== without);
    while (queue.length > 0) {
      const id = queue.shift()!;
      if (id === targetId) return true;
      if (seen.has(id)) continue;
      seen.add(id);
      for (const next of outgoing.get(id) ?? []) if (next !== without) queue.push(next);
    }
    return false;
  };

  const result = new Set<string>();
  if (!ids.has(targetId) || !reachesTarget(null)) return result;
  for (const node of graph.nodes) {
    if (node.id !== targetId && !reachesTarget(node.id)) result.add(node.id);
  }
  return result;
}

/** AI steps and non-wait actions record output a condition can read. */
export function producesStepOutput(node: Pick<SnapshotNode, "type" | "config">): boolean {
  return node.type === "ai" || (node.type === "action" && node.config.action !== "wait");
}

/** Output-producing steps guaranteed to have run before this condition. */
export function referenceableSteps<T extends Pick<SnapshotNode, "id" | "type" | "config">>(
  graph: { nodes: T[]; connections: GraphShape["connections"] },
  conditionId: string,
): T[] {
  const before = guaranteedPredecessors(graph, conditionId);
  return graph.nodes.filter((node) => before.has(node.id) && producesStepOutput(node));
}

/**
 * Output fields a step is known to produce, or null when they can't be known
 * statically (freeform AI steps, actions).
 */
export function knownOutputFields(node: Pick<SnapshotNode, "type" | "config">): string[] | null {
  if (node.type !== "ai") return null;
  const schema = aiOutputSchema(node.config as Partial<AIConfig>);
  return schema.length > 0 ? [...schema.map((field) => field.name), AI_TEXT_KEY] : null;
}

/** The node a reference key points at: a node-id key first, then the legacy name-derived key. */
export function referencedNode<T extends Pick<SnapshotNode, "id" | "name">>(nodes: T[], key: string): T | null {
  const byId = nodes.find((node) => nodeReferenceKey(node.id) === key);
  if (byId) return byId;
  const keys = stepKeys(nodes);
  return nodes.find((node) => keys.get(node.id) === key) ?? null;
}

/**
 * Points a node-id reference at the step key the run records outputs under.
 * Legacy name-derived references, and ids not in this snapshot, are unchanged.
 */
export function resolveStepReference(
  rule: ConditionRule,
  nodes: Pick<SnapshotNode, "id">[],
  keys: Map<string, string>,
): ConditionRule {
  const match = STEP_FIELD_PATTERN.exec(rule.field);
  if (!match) return rule;
  const node = nodes.find((entry) => nodeReferenceKey(entry.id) === match[1]);
  const key = node ? keys.get(node.id) : undefined;
  return key && key !== match[1] ? { ...rule, field: `steps.${key}.output.${match[2]}` } : rule;
}

/** Reference problems in every rule of a condition; rule-list conditions name the rule. */
function stepReferenceIssues(graph: JourneyGraph | JourneySnapshot, condition: SnapshotNode | JourneyNode): string[] {
  const config = condition.config as Record<string, unknown>;
  const multi = Object.hasOwn(config, "rules") && config.rules !== undefined;
  const issues: string[] = [];
  conditionRules(config).rules.forEach((rule, index) => {
    const problem = stepReferenceIssue(graph, condition, rule.field);
    if (problem) issues.push(multi ? `Rule ${index + 1}: ${problem}` : problem);
  });
  return issues;
}

function stepReferenceIssue(
  graph: JourneyGraph | JourneySnapshot,
  condition: SnapshotNode | JourneyNode,
  ruleField: unknown,
): string | null {
  const match = STEP_FIELD_PATTERN.exec(typeof ruleField === "string" ? ruleField : "");
  if (!match) return null;
  const [, key, field] = match;
  const source = referencedNode(graph.nodes, key);
  if (!source) return "the referenced journey step no longer exists.";
  if (source.id === condition.id) return "a condition can't reference its own output.";
  if (!producesStepOutput(source)) return `${label(source)} isn't a step that produces output a condition can use.`;
  if (!guaranteedPredecessors(graph, condition.id).has(source.id)) {
    return `${label(source)} doesn't run before this condition on every path.`;
  }
  const fields = knownOutputFields(source);
  if (fields && !fields.includes(field)) return `output field "${field}" isn't defined by ${label(source)}.`;
  return null;
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
 * the builder can show them together. With `journeyId`, a Start journey step
 * that targets this same journey is an issue.
 */
export function activationIssues(graph: JourneyGraph | JourneySnapshot, journeyId?: string): ActivationIssue[] {
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
    if (node.type === "condition") {
      for (const problem of stepReferenceIssues(graph, node)) {
        issues.push({ nodeId: node.id, message: `${label(node)}: ${problem}` });
      }
    }
    const config = node.config as Record<string, unknown>;
    if (journeyId && node.type === "action" && config.action === "start_journey" && config.journeyId === journeyId) {
      issues.push({ nodeId: node.id, message: `${label(node)}: a journey can't start itself.` });
    }
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
