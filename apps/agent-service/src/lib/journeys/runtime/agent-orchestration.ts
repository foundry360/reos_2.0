/**
 * Agent-requested journey starts. An AI step whose designer allowed it may ask
 * the engine to start one journey from the step's own list. The model only
 * ever sees opaque keys (journey_1, …), descriptions, and input names; its
 * request is untrusted data that this module checks before the engine starts
 * anything through the same path as a Start journey step.
 */

import {
  agentJourneyKey,
  INPUT_NAME_PATTERN,
  parseAgentJourneyTargets,
  type AgentJourneyTarget,
  type AIConfig,
} from "./contracts.ts";

/** One journey the AI step may ask for, under the key the model uses. */
export interface AllowedAgentJourney {
  key: string;
  target: AgentJourneyTarget;
}

/** What the model is told about one allowed journey. Never the journey id. */
export interface AgentJourneyOption {
  key: string;
  description: string;
  inputs: Array<{ name: string; description: string }>;
}

/** Why an agent's request was refused before anything was started. */
export type AgentRequestRefusal = "orchestration_disabled" | "invalid_request" | "target_not_allowed" | "inputs_invalid";

/**
 * The journeys an AI step may ask to start, keyed by their position in the
 * designer's list; null when the step isn't allowed to ask. Rows without a
 * valid journey, and repeats, are left out but keep the others' keys.
 */
export function allowedAgentJourneys(config: Partial<AIConfig>): AllowedAgentJourney[] | null {
  if (config.allowJourneyOrchestration !== true) return null;
  const seen = new Set<string>();
  const allowed: AllowedAgentJourney[] = [];
  parseAgentJourneyTargets(config.orchestrationJourneys, "draft").targets.forEach((target, index) => {
    if (!target.journeyId || seen.has(target.journeyId)) return;
    seen.add(target.journeyId);
    const inputs = (target.inputs ?? []).filter((input, position, all) =>
      INPUT_NAME_PATTERN.test(input.name) && all.findIndex((other) => other.name === input.name) === position,
    );
    allowed.push({ key: agentJourneyKey(index), target: { ...target, inputs } });
  });
  return allowed;
}

export function agentJourneyOption({ key, target }: AllowedAgentJourney): AgentJourneyOption {
  return { key, description: target.description, inputs: target.inputs ?? [] };
}

export type ParsedAgentRequest =
  | { ok: true; allowed: AllowedAgentJourney; values: Record<string, unknown> }
  | { ok: false; reason: AgentRequestRefusal; errors: string[]; key?: string };

const REQUEST_FIELDS = new Set(["journey", "inputs"]);

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/**
 * Checks a model's request ({ journey: <key>, inputs?: { <name>: value } })
 * against the step's allowed journeys. Anything else in the request (a run,
 * depth, workspace, contact, or payload field) refuses it. Inputs must be ones
 * the chosen journey declares; their values are checked as Stage 3 inputs
 * when the child is started. Error text never echoes the model's values.
 */
export function parseAgentJourneyRequest(raw: unknown, allowed: AllowedAgentJourney[]): ParsedAgentRequest {
  if (!isPlainObject(raw)) return { ok: false, reason: "invalid_request", errors: ["The request isn't an object."] };
  if (Object.keys(raw).some((field) => !REQUEST_FIELDS.has(field))) {
    return { ok: false, reason: "invalid_request", errors: ["The request may only name a journey and its inputs."] };
  }
  if (typeof raw.journey !== "string") return { ok: false, reason: "invalid_request", errors: ["The request doesn't name a journey."] };
  const choice = allowed.find((entry) => entry.key === raw.journey);
  if (!choice) return { ok: false, reason: "target_not_allowed", errors: ["That journey isn't one this step may start."] };

  const supplied = raw.inputs === undefined || raw.inputs === null ? {} : raw.inputs;
  if (!isPlainObject(supplied)) {
    return { ok: false, reason: "inputs_invalid", errors: ["Inputs must be named values."], key: choice.key };
  }
  const declared = new Set((choice.target.inputs ?? []).map((input) => input.name));
  const errors = Object.keys(supplied)
    .filter((name) => !declared.has(name))
    .map((name) => `Input ${INPUT_NAME_PATTERN.test(name) ? `"${name}"` : "?"} isn't one this journey takes.`);
  if (errors.length > 0) return { ok: false, reason: "inputs_invalid", errors, key: choice.key };
  const values: Record<string, unknown> = {};
  for (const name of declared) if (Object.hasOwn(supplied, name)) values[name] = supplied[name];
  return { ok: true, allowed: choice, values };
}
