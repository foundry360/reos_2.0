import type { JourneyNodeConfig, JourneyNodeType } from "./journey-types";

export interface JourneyNodeTypeDefinition {
  type: JourneyNodeType;
  label: string;
  description: string;
  /** Triggers start a journey, so nothing may connect into them. */
  acceptsIncoming: boolean;
  acceptsOutgoing: boolean;
  defaultConfig: () => JourneyNodeConfig;
}

export const JOURNEY_NODE_TYPE_DEFINITIONS: Record<JourneyNodeType, JourneyNodeTypeDefinition> = {
  trigger: {
    type: "trigger",
    label: "Trigger",
    description: "Defines the event that starts the journey.",
    acceptsIncoming: false,
    acceptsOutgoing: true,
    defaultConfig: () => ({}),
  },
  ai: {
    type: "ai",
    label: "AI",
    description: "Represents an AI-powered decision or action.",
    acceptsIncoming: true,
    acceptsOutgoing: true,
    defaultConfig: () => ({}),
  },
  condition: {
    type: "condition",
    label: "Condition",
    description: "Determines which path the journey follows.",
    acceptsIncoming: true,
    acceptsOutgoing: true,
    defaultConfig: () => ({}),
  },
  action: {
    type: "action",
    label: "Action",
    description: "Performs an operation within the journey.",
    acceptsIncoming: true,
    acceptsOutgoing: true,
    defaultConfig: () => ({}),
  },
};

/** Picker order mirrors the typical flow: Trigger → AI → Condition → Action. */
export const JOURNEY_NODE_PICKER_ORDER: JourneyNodeType[] = ["trigger", "ai", "condition", "action"];

export function journeyNodeTypeDefinition(type: JourneyNodeType): JourneyNodeTypeDefinition {
  return JOURNEY_NODE_TYPE_DEFINITIONS[type];
}
