"use server";

import { randomUUID } from "node:crypto";
import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { resolveCurrentTenant } from "@/lib/tenant/current-tenant";
import {
  createJourney,
  deleteJourney,
  duplicateJourney,
  saveJourney,
  setJourneyStatus,
} from "./journey-repository";
import { cancelJourneyRun, createManualEnrollmentLookups, retryFailedJourneyRun } from "./journey-run-repository";
import { emitJourneyEvent } from "./emit-journey-event";
import { enrollContactInJourney } from "./runtime/manual-enrollment";
import { JOURNEY_TEMPLATES, isJourneyTemplateId } from "./journey-templates";
import {
  isJourneyNodeType,
  isJourneyStatus,
  type JourneyGraph,
  type JourneyStatus,
} from "./journey-types";
import {
  validateJourneyDescription,
  validateJourneyGraph,
  validateJourneyName,
} from "./journey-validation";
import { validateNodeConfig } from "./runtime/contracts";

export interface JourneyActionResult {
  ok: boolean;
  error?: string;
  id?: string;
  version?: number;
  status?: JourneyStatus;
  updatedAt?: string;
}

const JOURNEYS_PATH = "/marketing/journeys";

async function requireContext(): Promise<
  { tenantId: string; userId: string | null } | { error: string }
> {
  const { tenantId } = await resolveCurrentTenant();
  if (!tenantId) return { error: "Your account is not linked to a workspace yet." };
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  return { tenantId, userId: user?.id ?? null };
}

function revalidateJourneys(journeyId?: string) {
  revalidatePath(JOURNEYS_PATH);
  if (journeyId) revalidatePath(`${JOURNEYS_PATH}/${journeyId}`);
}

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/** Rebuilds the graph from untrusted client input, keeping only known fields. */
function parseGraphInput(input: unknown): JourneyGraph | null {
  if (!input || typeof input !== "object") return null;
  const raw = input as { nodes?: unknown; connections?: unknown };
  if (!Array.isArray(raw.nodes) || !Array.isArray(raw.connections)) return null;

  const nodes: JourneyGraph["nodes"] = [];
  for (const entry of raw.nodes) {
    if (!entry || typeof entry !== "object") return null;
    const node = entry as Record<string, unknown>;
    if (!isJourneyNodeType(node.type)) return null;
    const position = (node.position ?? {}) as Record<string, unknown>;
    const { config } = validateNodeConfig(node.type, node.config, "draft");
    nodes.push({
      id: text(node.id),
      type: node.type,
      name: text(node.name),
      description: text(node.description),
      position: { x: Number(position.x), y: Number(position.y) },
      config,
    });
  }

  const connections: JourneyGraph["connections"] = [];
  for (const entry of raw.connections) {
    if (!entry || typeof entry !== "object") return null;
    const connection = entry as Record<string, unknown>;
    connections.push({
      id: text(connection.id),
      sourceNodeId: text(connection.sourceNodeId),
      targetNodeId: text(connection.targetNodeId),
      sourceHandle: text(connection.sourceHandle) || null,
      targetHandle: text(connection.targetHandle) || null,
    });
  }

  return { nodes, connections };
}

export async function createJourneyAction(input: {
  name: string;
  description?: string;
  templateId?: string;
}): Promise<JourneyActionResult> {
  const context = await requireContext();
  if ("error" in context) return { ok: false, error: context.error };

  const name = text(input.name);
  const description = text(input.description);
  const problem = validateJourneyName(name) ?? validateJourneyDescription(description);
  if (problem) return { ok: false, error: problem };

  const template = JOURNEY_TEMPLATES[isJourneyTemplateId(input.templateId) ? input.templateId : "blank"];
  const result = await createJourney({
    tenantId: context.tenantId,
    userId: context.userId,
    name,
    description,
    graph: template.buildGraph(randomUUID),
  });
  if (!result.ok) return { ok: false, error: result.error };

  revalidateJourneys();
  return { ok: true, id: result.value };
}

export async function saveJourneyAction(input: {
  journeyId: string;
  name: string;
  description: string;
  graph: unknown;
  expectedVersion: number;
}): Promise<JourneyActionResult> {
  const context = await requireContext();
  if ("error" in context) return { ok: false, error: context.error };

  const name = text(input.name);
  const description = text(input.description);
  const graph = parseGraphInput(input.graph);
  if (!graph) return { ok: false, error: "The journey canvas could not be read." };

  const problem =
    validateJourneyName(name) ??
    validateJourneyDescription(description) ??
    validateJourneyGraph(graph);
  if (problem) return { ok: false, error: problem };

  const result = await saveJourney({
    tenantId: context.tenantId,
    userId: context.userId,
    journeyId: text(input.journeyId),
    name,
    description,
    graph,
    expectedVersion: Number(input.expectedVersion),
  });
  if (!result.ok) return { ok: false, error: result.error };

  revalidateJourneys(input.journeyId);
  return { ok: true, version: result.value.version, updatedAt: result.value.updatedAt };
}

export async function setJourneyStatusAction(input: {
  journeyId: string;
  status: string;
}): Promise<JourneyActionResult> {
  const context = await requireContext();
  if ("error" in context) return { ok: false, error: context.error };
  if (!isJourneyStatus(input.status)) return { ok: false, error: "Unknown journey status." };

  const result = await setJourneyStatus({
    tenantId: context.tenantId,
    userId: context.userId,
    journeyId: text(input.journeyId),
    status: input.status,
  });
  if (!result.ok) return { ok: false, error: result.error };

  revalidateJourneys(input.journeyId);
  return { ok: true, status: result.value.status, updatedAt: result.value.updatedAt };
}

export async function duplicateJourneyAction(journeyId: string): Promise<JourneyActionResult> {
  const context = await requireContext();
  if ("error" in context) return { ok: false, error: context.error };

  const result = await duplicateJourney({
    tenantId: context.tenantId,
    userId: context.userId,
    journeyId: text(journeyId),
    newId: randomUUID,
  });
  if (!result.ok) return { ok: false, error: result.error };

  revalidateJourneys();
  return { ok: true, id: result.value };
}

export async function cancelJourneyRunAction(runId: string): Promise<JourneyActionResult> {
  const context = await requireContext();
  if ("error" in context) return { ok: false, error: context.error };

  const result = await cancelJourneyRun(context.tenantId, text(runId));
  if (!result.ok) return { ok: false, error: result.error };

  revalidatePath(`${JOURNEYS_PATH}/${result.value.journeyId}/runs`);
  return { ok: true };
}

/** Re-runs the step a failed run stopped at; the worker continues the run from there. */
export async function retryJourneyRunAction(runId: string): Promise<JourneyActionResult> {
  const context = await requireContext();
  if ("error" in context) return { ok: false, error: context.error };

  const result = await retryFailedJourneyRun(context.tenantId, text(runId));
  if (!result.ok) return { ok: false, error: result.error };

  revalidatePath(`${JOURNEYS_PATH}/${result.value.journeyId}/runs`);
  return { ok: true };
}

export type JourneyEnrollmentOutcome =
  | "enrolled"
  | "already_active"
  | "invalid_journey"
  | "invalid_contact"
  | "unauthorized"
  | "failed";

export interface JourneyEnrollmentResult {
  ok: boolean;
  result: JourneyEnrollmentOutcome;
  error?: string;
}

const INVALID_JOURNEY_MESSAGES = {
  not_found: "Journey not found.",
  not_active: "Only active journeys can enroll leads.",
  no_manual_trigger: "This journey doesn't have a Manual enrollment trigger.",
} as const;

/**
 * Enrolls one contact in one active journey that has a Manual enrollment trigger.
 * Checks run here; the run itself starts through the normal journey event path
 * after the response (first steps run inline, waits and retries via the worker).
 */
export async function enrollContactInJourneyAction(input: {
  journeyId: string;
  contactId: string;
}): Promise<JourneyEnrollmentResult> {
  const context = await requireContext();
  if ("error" in context) return { ok: false, result: "unauthorized", error: context.error };
  if (!context.userId) return { ok: false, result: "unauthorized", error: "Sign in to enroll leads." };

  const journeyId = text(input.journeyId);
  const contactId = text(input.contactId);
  if (!journeyId) return { ok: false, result: "invalid_journey", error: INVALID_JOURNEY_MESSAGES.not_found };
  if (!contactId) return { ok: false, result: "invalid_contact", error: "Lead not found." };

  try {
    const outcome = await enrollContactInJourney(
      await createManualEnrollmentLookups(),
      emitJourneyEvent,
      { tenantId: context.tenantId, userId: context.userId, journeyId, contactId },
      randomUUID,
    );
    switch (outcome.result) {
      case "enrolled":
        return { ok: true, result: "enrolled" };
      case "already_active":
        return { ok: false, result: "already_active", error: "This lead is already in this journey." };
      case "invalid_contact":
        return { ok: false, result: "invalid_contact", error: "Lead not found." };
      case "invalid_journey":
        return { ok: false, result: "invalid_journey", error: INVALID_JOURNEY_MESSAGES[outcome.reason] };
    }
  } catch (error) {
    console.error("enrollContactInJourneyAction failed:", error instanceof Error ? error.message : error);
    return { ok: false, result: "failed", error: "Could not enroll the lead. Try again." };
  }
}

export async function deleteJourneyAction(journeyId: string): Promise<JourneyActionResult> {
  const context = await requireContext();
  if ("error" in context) return { ok: false, error: context.error };

  const result = await deleteJourney(context.tenantId, text(journeyId));
  if (!result.ok) return { ok: false, error: result.error };

  revalidateJourneys();
  return { ok: true };
}
