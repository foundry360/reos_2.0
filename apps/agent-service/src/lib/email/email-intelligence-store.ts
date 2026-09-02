"use server";

import { htmlToPlainText } from "@/lib/email/email-utils";
import { analyzeEmailIntelligence } from "@/lib/email/email-intelligence-analyze";
import { applyEmailIntelligence } from "@/lib/email/email-intelligence-apply";
import {
  type EmailIntelligence,
  type EmailIntelligenceInput,
  serializeEmailIntelligence,
} from "@/lib/email/email-intelligence";
import { getSupabaseAdmin } from "@/lib/supabase/admin";

/** Persist AI analysis on a crm_emails row. Used by agent pipelines. */
export async function persistEmailIntelligence(
  emailId: string,
  intelligence: EmailIntelligence,
  existingMetadata: Record<string, unknown> = {},
): Promise<boolean> {
  const db = getSupabaseAdmin();
  if (!db) return false;

  const payload = serializeEmailIntelligence(intelligence);
  const metadata = {
    ...existingMetadata,
    ...payload.metadata,
  };

  const { error } = await db
    .from("crm_emails")
    .update({
      requires_response: payload.requires_response,
      metadata,
    })
    .eq("id", emailId);

  if (error) {
    console.error("persistEmailIntelligence failed:", error.message);
    return false;
  }

  return true;
}

/**
 * Run the intelligence pipeline for one email.
 * Call after inbound sync or when re-analyzing a thread.
 */
export async function runEmailIntelligencePipeline(
  input: EmailIntelligenceInput,
): Promise<EmailIntelligence | null> {
  const db = getSupabaseAdmin();
  if (!db) return null;

  if (input.direction === "outbound") {
    await persistEmailIntelligence(input.emailId, {
      status: "skipped",
      requiresResponse: false,
    });
    return null;
  }

  await persistEmailIntelligence(input.emailId, { status: "pending" });

  const analysis = await analyzeEmailIntelligence(input);
  if (!analysis) return null;

  const intelligence: EmailIntelligence = {
    ...analysis,
    status: analysis.status === "failed" ? "failed" : "analyzed",
    analyzedAt: analysis.analyzedAt ?? new Date().toISOString(),
  };

  if (
    input.contactId &&
    intelligence.status === "analyzed" &&
    (intelligence.contactUpdates ||
      intelligence.suggestedAction ||
      intelligence.leadSignal ||
      intelligence.opportunitySignal ||
      intelligence.detectedAppointment)
  ) {
    await applyEmailIntelligence({
      tenantId: input.tenantId,
      contactId: input.contactId,
      opportunityId: input.opportunityId,
      emailSubject: input.subject,
      intelligence,
    });
  }

  await persistEmailIntelligence(input.emailId, intelligence);
  return intelligence;
}

/** Load a crm_emails row and run the intelligence pipeline. */
export async function runEmailIntelligencePipelineForEmail(
  emailId: string,
): Promise<EmailIntelligence | null> {
  const db = getSupabaseAdmin();
  if (!db) return null;

  const { data: row, error } = await db
    .from("crm_emails")
    .select(
      "id, tenant_id, contact_id, opportunity_id, direction, subject, body_html, body_text, snippet, metadata",
    )
    .eq("id", emailId)
    .maybeSingle();

  if (error || !row) {
    if (error) console.error("runEmailIntelligencePipelineForEmail:", error.message);
    return null;
  }

  const direction = row.direction === "inbound" ? "inbound" : "outbound";
  const input: EmailIntelligenceInput = {
    emailId: row.id,
    tenantId: row.tenant_id,
    contactId: row.contact_id,
    opportunityId: row.opportunity_id,
    direction,
    subject: row.subject ?? "",
    bodyHtml: row.body_html,
    bodyText: row.body_text ?? htmlToPlainText(row.body_html ?? ""),
    snippet: row.snippet,
  };

  return runEmailIntelligencePipeline(input);
}
