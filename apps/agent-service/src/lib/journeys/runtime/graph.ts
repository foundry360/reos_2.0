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
  CONDITION_FIELDS,
  conditionRules,
  fanOutChildKey,
  INPUT_NAME_PATTERN,
  nodeReferenceKey,
  parseFanOutChildren,
  parseInputMappings,
  parseResultExports,
  parseResultMappings,
  parseStepField,
  RESULT_SOURCE_PATTERN,
  stepKey,
  TRIGGER_EVENTS,
  TRIGGER_INPUT_FIELD_PATTERN,
  validateNodeConfig,
  type AIConfig,
  type ConditionRule,
  type FanOutChild,
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
  const fanOut = fanOutOutputFields(node);
  if (fanOut) return fanOut;
  const received = receivedResultNames(node);
  if (received.length > 0) return [...START_JOURNEY_OUTPUT_FIELDS, ...received.map((name) => `results.${name}`)];
  if (node.type !== "ai") return null;
  const schema = aiOutputSchema(node.config as Partial<AIConfig>);
  return schema.length > 0 ? [...schema.map((field) => field.name), AI_TEXT_KEY] : null;
}

/** What a waiting Start journey step records, besides received results. */
const START_JOURNEY_OUTPUT_FIELDS = ["child_status", "results_error", "started", "skipped_reason", "run_id", "target_journey_id", "causation_depth"];

/** The result names a waiting Start journey step receives (its mapping targets); empty for anything else. */
export function receivedResultNames(node: Pick<SnapshotNode, "type" | "config">): string[] {
  const config = node.config as Record<string, unknown>;
  if (node.type !== "action" || config.action !== "start_journey" || config.waitForCompletion !== true) return [];
  return parseResultMappings(config.resultMappings, "draft")
    .mappings.map((mapping) => mapping.target)
    .filter((target) => INPUT_NAME_PATTERN.test(target));
}

/** The distinct, well-formed children of a Start journeys step (null for any other node). */
export function fanOutChildren(node: Pick<SnapshotNode, "type" | "config">): FanOutChild[] | null {
  const config = node.config as Record<string, unknown>;
  if (node.type !== "action" || config.action !== "start_journeys") return null;
  const seen = new Set<string>();
  return parseFanOutChildren(config.journeys, "draft", config.waitForCompletion === true).children.filter((child) => {
    if (!child.journeyId || seen.has(child.journeyId)) return false;
    seen.add(child.journeyId);
    return true;
  });
}

/**
 * What a Start journeys step records that a condition can read: per configured
 * child (children.<child key>.…) started, skipped_reason, and child_status,
 * plus, when it waits, results_error and results.<name> for each result it
 * maps from that child. Children that aren't configured have no fields.
 */
export function fanOutOutputFields(node: Pick<SnapshotNode, "type" | "config">): string[] | null {
  const children = fanOutChildren(node);
  if (!children) return null;
  const wait = (node.config as Record<string, unknown>).waitForCompletion === true;
  const fields = ["causation_depth", ...(wait ? ["completion", "results_error"] : [])];
  for (const child of children) {
    const prefix = `children.${fanOutChildKey(child.journeyId)}.`;
    fields.push(`${prefix}child_status`, `${prefix}started`, `${prefix}skipped_reason`);
    if (!wait) continue;
    fields.push(`${prefix}results_error`);
    for (const { target } of parseResultMappings(child.resultMappings, "draft").mappings) {
      if (INPUT_NAME_PATTERN.test(target)) fields.push(`${prefix}results.${target}`);
    }
  }
  return fields;
}

/** Output-producing steps reachable from a trigger: what a journey's declared results can return. */
export function exportableSteps<T extends Pick<SnapshotNode, "id" | "type" | "config">>(graph: {
  nodes: T[];
  connections: GraphShape["connections"];
}): T[] {
  const reachable = reachableNodes(graph);
  return graph.nodes.filter((node) => reachable.has(node.id) && producesStepOutput(node));
}

function reachableNodes(graph: GraphShape): Set<string> {
  const outgoing = new Map<string, string[]>();
  for (const connection of graph.connections) {
    const list = outgoing.get(connection.sourceNodeId) ?? [];
    list.push(connection.targetNodeId);
    outgoing.set(connection.sourceNodeId, list);
  }
  const reachable = new Set<string>();
  const queue = graph.nodes.filter((node) => node.type === "trigger").map((node) => node.id);
  while (queue.length > 0) {
    const id = queue.shift()!;
    if (reachable.has(id)) continue;
    reachable.add(id);
    queue.push(...(outgoing.get(id) ?? []));
  }
  return reachable;
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
  const field = resolveStepField(rule.field, nodes, keys);
  return field === rule.field ? rule : { ...rule, field };
}

/** resolveStepReference for a bare field (a Start journey input's source). */
export function resolveStepField(field: string, nodes: Pick<SnapshotNode, "id">[], keys: Map<string, string>): string {
  const match = parseStepField(field);
  if (!match) return field;
  const node = nodes.find((entry) => nodeReferenceKey(entry.id) === match.key);
  const key = node ? keys.get(node.id) : undefined;
  return key && key !== match.key ? `steps.${key}.output.${match.field}` : field;
}

type GraphLike = JourneyGraph | JourneySnapshot;

/** Reference problems in every rule of a condition; rule-list conditions name the rule. */
function stepReferenceIssues(graph: GraphLike, condition: SnapshotNode | JourneyNode): string[] {
  const config = condition.config as Record<string, unknown>;
  const multi = Object.hasOwn(config, "rules") && config.rules !== undefined;
  const issues: string[] = [];
  conditionRules(config).rules.forEach((rule, index) => {
    const problem = stepReferenceIssue(graph, condition, rule.field) ?? triggerInputIssue(graph, rule.field);
    if (problem) issues.push(multi ? `Rule ${index + 1}: ${problem}` : problem);
  });
  return issues;
}

function stepReferenceIssue(
  graph: GraphLike,
  reader: SnapshotNode | JourneyNode,
  ruleField: unknown,
  subject: "condition" | "step" = "condition",
): string | null {
  const match = parseStepField(typeof ruleField === "string" ? ruleField : "");
  if (!match) return null;
  const { key, field } = match;
  const source = referencedNode(graph.nodes, key);
  if (!source) return "the referenced journey step no longer exists.";
  if (source.id === reader.id) return `a ${subject} can't reference its own output.`;
  if (!producesStepOutput(source)) return `${label(source)} isn't a step that produces output a ${subject} can use.`;
  if (!guaranteedPredecessors(graph, reader.id).has(source.id)) {
    return `${label(source)} doesn't run before this ${subject} on every path.`;
  }
  return outputFieldIssue(source, field);
}

/** A field the step doesn't produce: not in its known fields, or a result it doesn't receive. */
function outputFieldIssue(source: SnapshotNode | JourneyNode, field: string): string | null {
  if (field.startsWith("results.") && !receivedResultNames(source).includes(field.slice("results.".length))) {
    return `${label(source)} doesn't receive a result named "${field.slice("results.".length)}".`;
  }
  if (field.startsWith("children.") && !fanOutOutputFields(source)?.includes(field)) {
    return fanOutChildren(source)
      ? `${label(source)} doesn't start that journey or doesn't record "${field.split(".").slice(2).join(".")}" for it.`
      : `${label(source)} isn't a Start journeys step.`;
  }
  const fields = knownOutputFields(source);
  if (fields && !fields.includes(field)) return `output field "${field}" isn't defined by ${label(source)}.`;
  return null;
}

/**
 * Problems with a trigger's declared results that need the whole graph: each
 * source must be an output-producing step reachable from a trigger, and a
 * field that step defines. A step that doesn't run on every path returns
 * empty when it didn't run.
 */
function resultExportIssues(graph: GraphLike, trigger: SnapshotNode | JourneyNode): string[] {
  const issues: string[] = [];
  const reachable = reachableNodes(graph);
  for (const { name, source } of parseResultExports((trigger.config as Record<string, unknown>).results, "draft").exports) {
    const match = parseStepField(source);
    if (!match) continue;
    const node = referencedNode(graph.nodes, match.key);
    const problem = !node
      ? "the referenced journey step no longer exists."
      : !producesStepOutput(node)
        ? `${label(node)} isn't a step that produces output a result can return.`
        : !reachable.has(node.id)
          ? `${label(node)} isn't reachable from a trigger.`
          : outputFieldIssue(node, match.field);
    if (problem) issues.push(`Result "${name || "?"}": ${problem}`);
  }
  return issues;
}

function triggerEvents(graph: GraphLike): string[] {
  return graph.nodes.filter((node) => node.type === "trigger").map((node) => String(node.config.event ?? ""));
}

/** trigger.inputs.<name> needs a journey.started trigger; nothing else has inputs. */
function triggerInputIssue(graph: GraphLike, field: unknown): string | null {
  if (typeof field !== "string" || !TRIGGER_INPUT_FIELD_PATTERN.test(field)) return null;
  return triggerEvents(graph).includes("journey.started")
    ? null
    : `inputs only exist when another journey starts this one ("${TRIGGER_EVENTS["journey.started"].label}" trigger).`;
}

/** Problems with a Start journey(s) step's input sources (`rawMappings`) that need the whole graph. */
function inputSourceIssues(graph: GraphLike, node: SnapshotNode | JourneyNode, rawMappings: unknown): string[] {
  const issues: string[] = [];
  const events = triggerEvents(graph);
  for (const { target, source } of parseInputMappings(rawMappings, "draft").mappings) {
    if (!source) continue;
    const definition = Object.hasOwn(CONDITION_FIELDS, source) ? CONDITION_FIELDS[source] : null;
    const problem =
      stepReferenceIssue(graph, node, source, "step") ??
      triggerInputIssue(graph, source) ??
      (definition?.events && !definition.events.some((event) => events.includes(event))
        ? `"${definition.label}" isn't part of this journey's trigger event.`
        : null);
    if (problem) issues.push(`Input "${target || "?"}": ${problem}`);
  }
  return issues;
}

/**
 * Received results the started journey doesn't declare. `declared` is null
 * when the target declares nothing (or isn't known): every mapping is then an issue.
 */
function undeclaredResultIssues(rawMappings: unknown, declared: readonly string[] | null): string[] {
  return parseResultMappings(rawMappings, "draft").mappings.flatMap(({ target, source }) => {
    const name = RESULT_SOURCE_PATTERN.exec(source)?.[1];
    return name && !declared?.includes(name) ? [`Result "${target || "?"}": the started journey doesn't return "${name}".`] : [];
  });
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
 * the builder can show them together. With `journeyId`, a Start journey(s)
 * step that targets this same journey is an issue. With `declaredResults` (the
 * result names each journey in the workspace declares), a received result its
 * target doesn't declare is an issue.
 */
export function activationIssues(
  graph: JourneyGraph | JourneySnapshot,
  journeyId?: string,
  declaredResults?: ReadonlyMap<string, readonly string[]>,
): ActivationIssue[] {
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
    if (node.type === "action" && config.action === "start_journey") {
      const problems = [
        ...inputSourceIssues(graph, node, config.inputMappings),
        ...(declaredResults && config.waitForCompletion === true && typeof config.journeyId === "string"
          ? undeclaredResultIssues(config.resultMappings, declaredResults.get(config.journeyId.toLowerCase()) ?? null)
          : []),
      ];
      for (const problem of problems) issues.push({ nodeId: node.id, message: `${label(node)}: ${problem}` });
    }
    if (node.type === "action" && config.action === "start_journeys") {
      const rows = parseFanOutChildren(config.journeys, "draft", config.waitForCompletion === true).children;
      rows.forEach((child, index) => {
        const problems = [
          ...(journeyId && child.journeyId === journeyId.toLowerCase() ? ["a journey can't start itself."] : []),
          ...inputSourceIssues(graph, node, child.inputMappings),
          ...(declaredResults && child.journeyId ? undeclaredResultIssues(child.resultMappings, declaredResults.get(child.journeyId) ?? null) : []),
        ];
        for (const problem of problems) issues.push({ nodeId: node.id, message: `${label(node)}: Journey ${index + 1}: ${problem}` });
      });
    }
    if (node.type === "trigger") {
      for (const problem of resultExportIssues(graph, node)) {
        issues.push({ nodeId: node.id, message: `${label(node)}: ${problem}` });
      }
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
