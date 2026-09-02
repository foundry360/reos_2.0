/**
 * Email Intelligence — data model and extension points for AI analysis.
 *
 * Stored on `crm_emails`:
 * - `requires_response` (boolean column, queryable)
 * - `metadata.intelligence` (full analysis payload)
 *
 * Future agents call `analyzeEmailIntelligence` then `persistEmailIntelligence`.
 */

export type EmailIntelligenceStatus = "pending" | "analyzed" | "skipped" | "failed";

export type EmailIntelligenceUrgency = "low" | "medium" | "high";

export interface EmailIntelligenceSignal {
  kind: "opportunity" | "lead" | "appointment" | "task" | "other";
  label: string;
  confidence?: number | null;
}

export interface EmailIntelligenceAction {
  /** Machine-readable action key, e.g. schedule_consultation, create_calendar_event */
  type: string;
  label: string;
  opportunityId?: string | null;
  opportunityName?: string | null;
}

export interface EmailIntelligence {
  status: EmailIntelligenceStatus;
  analyzedAt?: string | null;
  intent?: string | null;
  sentiment?: string | null;
  urgency?: EmailIntelligenceUrgency | null;
  requiresResponse?: boolean | null;
  suggestedResponse?: string | null;
  detectedTask?: string | null;
  detectedAppointment?: string | null;
  opportunitySignal?: EmailIntelligenceSignal | null;
  leadSignal?: EmailIntelligenceSignal | null;
  suggestedAction?: EmailIntelligenceAction | null;
  /** CRM field updates to apply via update_contact. */
  contactUpdates?: Record<string, unknown> | null;
  /** Model or pipeline that produced this analysis. */
  model?: string | null;
  error?: string | null;
}

export interface EmailIntelligenceInput {
  emailId: string;
  tenantId: string;
  contactId?: string | null;
  opportunityId?: string | null;
  direction: "inbound" | "outbound";
  subject: string;
  bodyText?: string | null;
  bodyHtml?: string | null;
  snippet?: string | null;
}

const INTELLIGENCE_METADATA_KEY = "intelligence";

function readString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function readUrgency(value: unknown): EmailIntelligenceUrgency | null {
  return value === "low" || value === "medium" || value === "high" ? value : null;
}

function readStatus(value: unknown): EmailIntelligenceStatus {
  if (
    value === "pending" ||
    value === "analyzed" ||
    value === "skipped" ||
    value === "failed"
  ) {
    return value;
  }
  return "pending";
}

function readSignal(value: unknown): EmailIntelligenceSignal | null {
  if (!value || typeof value !== "object") return null;
  const row = value as Record<string, unknown>;
  const label = readString(row.label);
  if (!label) return null;
  const kind = row.kind;
  if (
    kind !== "opportunity" &&
    kind !== "lead" &&
    kind !== "appointment" &&
    kind !== "task" &&
    kind !== "other"
  ) {
    return null;
  }
  const confidence =
    typeof row.confidence === "number" && Number.isFinite(row.confidence)
      ? row.confidence
      : null;
  return { kind, label, confidence };
}

function readAction(value: unknown): EmailIntelligenceAction | null {
  if (!value || typeof value !== "object") return null;
  const row = value as Record<string, unknown>;
  const type = readString(row.type);
  const label = readString(row.label);
  if (!type || !label) return null;
  return {
    type,
    label,
    opportunityId: readString(row.opportunityId ?? row.opportunity_id),
    opportunityName: readString(row.opportunityName ?? row.opportunity_name),
  };
}

/** Parse intelligence from a crm_emails row. */
export function parseEmailIntelligence(
  requiresResponse: boolean | null | undefined,
  metadata: unknown,
): EmailIntelligence | null {
  const meta =
    metadata && typeof metadata === "object"
      ? (metadata as Record<string, unknown>)
      : null;
  const raw = meta?.[INTELLIGENCE_METADATA_KEY];

  if (!raw || typeof raw !== "object") {
    if (requiresResponse == null) return null;
    return {
      status: "analyzed",
      requiresResponse: requiresResponse,
    };
  }

  const row = raw as Record<string, unknown>;
  const intelligence: EmailIntelligence = {
    status: readStatus(row.status),
    analyzedAt: readString(row.analyzedAt ?? row.analyzed_at),
    intent: readString(row.intent),
    sentiment: readString(row.sentiment),
    urgency: readUrgency(row.urgency),
    requiresResponse:
      typeof row.requiresResponse === "boolean"
        ? row.requiresResponse
        : typeof row.requires_response === "boolean"
          ? row.requires_response
          : requiresResponse ?? null,
    suggestedResponse: readString(row.suggestedResponse ?? row.suggested_response),
    detectedTask: readString(row.detectedTask ?? row.detected_task),
    detectedAppointment: readString(row.detectedAppointment ?? row.detected_appointment),
    opportunitySignal: readSignal(row.opportunitySignal ?? row.opportunity_signal),
    leadSignal: readSignal(row.leadSignal ?? row.lead_signal),
    suggestedAction: readAction(row.suggestedAction ?? row.suggested_action),
    contactUpdates:
      row.contactUpdates && typeof row.contactUpdates === "object"
        ? (row.contactUpdates as Record<string, unknown>)
        : row.contact_updates && typeof row.contact_updates === "object"
          ? (row.contact_updates as Record<string, unknown>)
          : null,
    model: readString(row.model),
    error: readString(row.error),
  };

  if (intelligence.status === "skipped" || intelligence.status === "pending") {
    const hasAnalysis =
      intelligence.intent ||
      intelligence.sentiment ||
      intelligence.urgency ||
      intelligence.requiresResponse != null ||
      intelligence.suggestedResponse ||
      intelligence.detectedTask ||
      intelligence.detectedAppointment ||
      intelligence.opportunitySignal ||
      intelligence.leadSignal ||
      intelligence.suggestedAction;
    if (!hasAnalysis) return null;
  }

  return intelligence;
}

/** Serialize intelligence for crm_emails insert/update. */
export function serializeEmailIntelligence(intelligence: EmailIntelligence): {
  requires_response: boolean | null;
  metadata: Record<string, unknown>;
} {
  return {
    requires_response:
      typeof intelligence.requiresResponse === "boolean"
        ? intelligence.requiresResponse
        : null,
    metadata: {
      [INTELLIGENCE_METADATA_KEY]: {
        status: intelligence.status,
        analyzedAt: intelligence.analyzedAt ?? null,
        intent: intelligence.intent ?? null,
        sentiment: intelligence.sentiment ?? null,
        urgency: intelligence.urgency ?? null,
        requiresResponse: intelligence.requiresResponse ?? null,
        suggestedResponse: intelligence.suggestedResponse ?? null,
        detectedTask: intelligence.detectedTask ?? null,
        detectedAppointment: intelligence.detectedAppointment ?? null,
        opportunitySignal: intelligence.opportunitySignal ?? null,
        leadSignal: intelligence.leadSignal ?? null,
        suggestedAction: intelligence.suggestedAction ?? null,
        contactUpdates: intelligence.contactUpdates ?? null,
        model: intelligence.model ?? null,
        error: intelligence.error ?? null,
      },
    },
  };
}

/**
 * Analyze an email with REOS agents/LLM.
 * Implemented in email-intelligence-analyze.ts (server-only import).
 */
export async function analyzeEmailIntelligence(
  _input: EmailIntelligenceInput,
): Promise<EmailIntelligence | null> {
  const { analyzeEmailIntelligence: analyze } = await import(
    "@/lib/email/email-intelligence-analyze"
  );
  return analyze(_input);
}

/** Queue analysis for later (inbound sync, background job). */
export async function enqueueEmailIntelligenceAnalysis(
  emailId: string,
): Promise<void> {
  const { runEmailIntelligencePipelineForEmail } = await import(
    "@/lib/email/email-intelligence-store"
  );
  await runEmailIntelligencePipelineForEmail(emailId);
}
