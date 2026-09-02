import OpenAI from "openai";
import {
  getOpenAIApiKey,
  getOpenAIModel,
  isOpenAIConfiguredAsync,
} from "@/lib/admin/platform-credentials";
import { htmlToPlainText } from "@/lib/email/email-utils";
import type {
  EmailIntelligence,
  EmailIntelligenceInput,
} from "@/lib/email/email-intelligence";

const SYSTEM_PROMPT = `You analyze inbound CRM emails from leads/clients to a real estate agent.
Extract purchase intent, budget changes, timeline shifts, showing requests, and readiness signals.
Return JSON only. Update CRM only when the email clearly states new facts — do not invent data.

Examples:
Email: "We're ready to start looking at homes next weekend."
→ intent: "Buyer readiness", lead_signal: "Increased purchase intent", suggested_action: schedule_consultation, contact_updates: { ready_to_book: true, lead_temperature: "Hot", timeline: "0-30 Days", recommended_next_action: "Schedule buyer consultation" }

Email: "Can you show us the house on Oak Street Saturday at 2?"
→ intent: "Showing request", suggested_action: create_calendar_event, detected_appointment: "Showing — Oak Street, Saturday 2:00 PM", contact_updates: { ready_to_book: true, recommended_next_action: "Create calendar event for showing" }

Email: "We want to increase our budget to 650k."
→ contact_updates: { budget: "$650,000" }, lead_signal: "Budget increased"`;

type AnalysisResponse = {
  has_signals?: boolean;
  intent?: string | null;
  sentiment?: string | null;
  urgency?: "low" | "medium" | "high" | null;
  requires_response?: boolean;
  lead_signal?: string | null;
  opportunity_signal?: string | null;
  suggested_action?: {
    type?: string;
    label?: string;
  } | null;
  detected_appointment?: string | null;
  detected_task?: string | null;
  contact_updates?: Record<string, unknown> | null;
};

function readText(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function emailBody(input: EmailIntelligenceInput): string {
  const fromText = input.bodyText?.trim();
  if (fromText) return fromText;
  if (input.bodyHtml?.trim()) return htmlToPlainText(input.bodyHtml);
  return input.snippet?.trim() ?? "";
}

export async function analyzeEmailIntelligence(
  input: EmailIntelligenceInput,
): Promise<EmailIntelligence | null> {
  if (input.direction !== "inbound") return null;
  if (!(await isOpenAIConfiguredAsync())) return null;

  const body = emailBody(input);
  if (!body && !input.subject.trim()) return null;

  const apiKey = await getOpenAIApiKey();
  if (!apiKey) return null;

  const client = new OpenAI({ apiKey });
  const model = getOpenAIModel();

  const userContent = [
    `Subject: ${input.subject.trim() || "(no subject)"}`,
    "",
    body || "(empty body)",
  ].join("\n");

  try {
    const completion = await client.chat.completions.create({
      model,
      temperature: 0.2,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        {
          role: "user",
          content: `${userContent}\n\nRespond with JSON:\n{\n  "has_signals": boolean,\n  "intent": string | null,\n  "sentiment": string | null,\n  "urgency": "low" | "medium" | "high" | null,\n  "requires_response": boolean,\n  "lead_signal": string | null,\n  "opportunity_signal": string | null,\n  "suggested_action": { "type": string, "label": string } | null,\n  "detected_appointment": string | null,\n  "detected_task": string | null,\n  "contact_updates": object | null\n}`,
        },
      ],
    });

    const raw = completion.choices[0]?.message?.content;
    if (!raw) return null;

    const parsed = JSON.parse(raw) as AnalysisResponse;
    if (!parsed.has_signals) {
      return {
        status: "analyzed",
        analyzedAt: new Date().toISOString(),
        requiresResponse: parsed.requires_response ?? false,
        model,
      };
    }

    const suggested = parsed.suggested_action;
    const actionType = readText(suggested?.type);
    const actionLabel = readText(suggested?.label);

    return {
      status: "analyzed",
      analyzedAt: new Date().toISOString(),
      intent: readText(parsed.intent),
      sentiment: readText(parsed.sentiment),
      urgency:
        parsed.urgency === "low" ||
        parsed.urgency === "medium" ||
        parsed.urgency === "high"
          ? parsed.urgency
          : null,
      requiresResponse: parsed.requires_response ?? true,
      detectedTask: readText(parsed.detected_task),
      detectedAppointment: readText(parsed.detected_appointment),
      leadSignal: readText(parsed.lead_signal)
        ? { kind: "lead", label: readText(parsed.lead_signal)! }
        : null,
      opportunitySignal: readText(parsed.opportunity_signal)
        ? { kind: "opportunity", label: readText(parsed.opportunity_signal)! }
        : null,
      suggestedAction:
        actionType && actionLabel
          ? { type: actionType, label: actionLabel }
          : null,
      contactUpdates:
        parsed.contact_updates && typeof parsed.contact_updates === "object"
          ? parsed.contact_updates
          : null,
      model,
    };
  } catch (error) {
    console.error("analyzeEmailIntelligence failed:", error);
    return {
      status: "failed",
      error: error instanceof Error ? error.message : "Analysis failed",
      model,
    };
  }
}
