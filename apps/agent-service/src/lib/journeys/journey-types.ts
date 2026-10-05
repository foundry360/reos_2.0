/**
 * Journey definition model. REOS owns this definition; a future journey engine
 * will evaluate it against events. Nothing here executes.
 */

export const JOURNEY_STATUSES = ["draft", "active", "paused", "archived"] as const;
export type JourneyStatus = (typeof JOURNEY_STATUSES)[number];

export const JOURNEY_NODE_TYPES = ["trigger", "ai", "condition", "action"] as const;
export type JourneyNodeType = (typeof JOURNEY_NODE_TYPES)[number];

/** Node-specific settings. Each node type will define its own shape in later iterations. */
export type JourneyNodeConfig = Record<string, unknown>;

export interface JourneyNode {
  id: string;
  type: JourneyNodeType;
  name: string;
  description: string;
  position: { x: number; y: number };
  config: JourneyNodeConfig;
}

/** Condition nodes branch through two named exits, stored as the connection's source handle. */
export const CONDITION_HANDLES = { yes: "yes", no: "no" } as const;

export function connectionLabel(sourceHandle: string | null | undefined): string | undefined {
  if (sourceHandle === CONDITION_HANDLES.yes) return "Yes";
  if (sourceHandle === CONDITION_HANDLES.no) return "No";
  return undefined;
}

export interface JourneyConnection {
  id: string;
  sourceNodeId: string;
  targetNodeId: string;
  sourceHandle: string | null;
  targetHandle: string | null;
}

export interface JourneyGraph {
  nodes: JourneyNode[];
  connections: JourneyConnection[];
}

export interface JourneySummary {
  id: string;
  name: string;
  description: string;
  status: JourneyStatus;
  nodeCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface JourneyDefinition extends JourneyGraph {
  id: string;
  name: string;
  description: string;
  status: JourneyStatus;
  version: number;
  createdAt: string;
  updatedAt: string;
}

export function isJourneyStatus(value: unknown): value is JourneyStatus {
  return typeof value === "string" && (JOURNEY_STATUSES as readonly string[]).includes(value);
}

export function isJourneyNodeType(value: unknown): value is JourneyNodeType {
  return typeof value === "string" && (JOURNEY_NODE_TYPES as readonly string[]).includes(value);
}

export const JOURNEY_STATUS_LABELS: Record<JourneyStatus, string> = {
  draft: "Draft",
  active: "Active",
  paused: "Paused",
  archived: "Archived",
};

/** Archived never runs; Restore returns it to draft, from where it is activated normally. */
const ALLOWED_TRANSITIONS: Record<JourneyStatus, readonly JourneyStatus[]> = {
  draft: ["active", "archived"],
  active: ["paused", "archived"],
  paused: ["active", "archived"],
  archived: ["draft"],
};

export function canTransitionJourney(from: JourneyStatus, to: JourneyStatus): boolean {
  return ALLOWED_TRANSITIONS[from].includes(to);
}

/** The single lifecycle action offered for a status (Activate / Pause / Resume / Restore). Archive is offered separately. */
export function nextJourneyStatus(status: JourneyStatus): {
  status: JourneyStatus;
  label: string;
} {
  if (status === "active") return { status: "paused", label: "Pause" };
  if (status === "paused") return { status: "active", label: "Resume" };
  if (status === "archived") return { status: "draft", label: "Restore" };
  return { status: "active", label: "Activate" };
}
