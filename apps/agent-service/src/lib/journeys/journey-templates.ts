import { journeyNodeTypeDefinition } from "./journey-node-types";
import {
  CONDITION_HANDLES,
  type JourneyGraph,
  type JourneyNode,
  type JourneyNodeType,
} from "./journey-types";

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
  x: number,
  config?: JourneyNode["config"],
): JourneyNode {
  return {
    id: newId(),
    type,
    name,
    description,
    position: { x, y: 0 },
    config: config ?? journeyNodeTypeDefinition(type).defaultConfig(),
  };
}

/** Links each node to the next, left to right; a condition continues down its Yes path. */
function chain(newId: () => string, nodes: JourneyNode[]): JourneyGraph {
  return {
    nodes,
    connections: nodes.slice(1).map((node, index) => ({
      id: newId(),
      sourceNodeId: nodes[index].id,
      targetNodeId: node.id,
      sourceHandle: nodes[index].type === "condition" ? CONDITION_HANDLES.yes : null,
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
    description: "Trigger → AI → Condition → Action example, ready to activate.",
    buildGraph: (newId) =>
      chain(newId, [
        templateNode(newId, "trigger", "New lead created", "Starts when a new lead enters REOS.", 0, {
          event: "lead.created",
          filters: [],
        }),
        templateNode(newId, "ai", "Qualify lead", "Assess intent, timeline, and budget.", 208, {
          goal: "Assess the lead's intent, timeline, and budget.",
          instructions: "",
          agent: "default",
        }),
        templateNode(newId, "condition", "Is qualified?", "Route qualified leads to an agent.", 416, {
          field: "lead.lead_status",
          operator: "equals",
          value: "Qualified",
        }),
        templateNode(newId, "action", "Notify agent", "Tell the lead's agent to follow up.", 624, {
          action: "notify_team",
          title: "Qualified lead: {{full_name}}",
          body: "A journey flagged this lead as qualified.",
          recipients: "assigned_agent",
        }),
      ]),
  },
};

export function isJourneyTemplateId(value: unknown): value is JourneyTemplateId {
  return typeof value === "string" && value in JOURNEY_TEMPLATES;
}
