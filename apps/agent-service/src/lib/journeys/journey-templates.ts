import { journeyNodeTypeDefinition } from "./journey-node-types";
import type { JourneyGraph, JourneyNode, JourneyNodeType } from "./journey-types";

export type JourneyTemplateId = "blank" | "new_lead_qualification";

export interface JourneyTemplate {
  id: JourneyTemplateId;
  name: string;
  description: string;
  buildGraph: (newId: () => string) => JourneyGraph;
}

function templateNode(
  newId: () => string,
  type: JourneyNodeType,
  name: string,
  description: string,
  y: number,
): JourneyNode {
  return {
    id: newId(),
    type,
    name,
    description,
    position: { x: 0, y },
    config: journeyNodeTypeDefinition(type).defaultConfig(),
  };
}

/** Links each node to the next, top to bottom. */
function chain(newId: () => string, nodes: JourneyNode[]): JourneyGraph {
  return {
    nodes,
    connections: nodes.slice(1).map((node, index) => ({
      id: newId(),
      sourceNodeId: nodes[index].id,
      targetNodeId: node.id,
      sourceHandle: null,
      targetHandle: null,
    })),
  };
}

export const JOURNEY_TEMPLATES: Record<JourneyTemplateId, JourneyTemplate> = {
  blank: {
    id: "blank",
    name: "Blank journey",
    description: "Start with an empty canvas.",
    buildGraph: () => ({ nodes: [], connections: [] }),
  },
  new_lead_qualification: {
    id: "new_lead_qualification",
    name: "New Lead Qualification",
    description: "Trigger → AI → Condition → Action example to explore the builder.",
    buildGraph: (newId) =>
      chain(newId, [
        templateNode(newId, "trigger", "New lead created", "Starts when a new lead enters REOS.", 0),
        templateNode(newId, "ai", "Qualify lead", "Assess intent, timeline, and budget.", 170),
        templateNode(newId, "condition", "Is qualified?", "Route qualified leads to an agent.", 340),
        templateNode(newId, "action", "Assign to agent", "Hand the lead to the right agent.", 510),
      ]),
  },
};

export function isJourneyTemplateId(value: unknown): value is JourneyTemplateId {
  return typeof value === "string" && value in JOURNEY_TEMPLATES;
}
