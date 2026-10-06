import { getSupabaseAdmin } from "@/lib/supabase/admin";

/**
 * The "Email sent" activity of an outbound email (migration 067). Moving an
 * email to sent marks its activity owed in the same statement (Journey and
 * compose email to a contact; never appointment email); these write it. Both
 * are idempotent: an email has at most one such activity, and one that can't
 * be written stays owed for the repair run.
 */

export type SentActivityOutcome = "created" | "exists" | "not_owed" | "missing" | "error";

export async function ensureEmailSentActivity(tenantId: string, emailId: string): Promise<SentActivityOutcome> {
  const db = getSupabaseAdmin();
  if (!db) {
    console.error("Email sent activity not written (no database); it stays owed for repair");
    return "error";
  }
  const { data, error } = await db.rpc("ensure_email_sent_activity", { p_email_id: emailId, p_tenant_id: tenantId });
  if (error || typeof data !== "string") {
    console.error("Email sent activity not written; it stays owed for repair:", error?.code ?? "no result");
    return "error";
  }
  return data as SentActivityOutcome;
}

export interface SentActivityRepairSummary {
  checked: number;
  created: number;
  existing: number;
  notOwed: number;
  failed: number;
  errors: number;
}

/** Writes owed activities in bounded batches; never touches send state. */
export async function repairEmailSentActivities(
  options: { batchSize?: number; maxBatches?: number; budgetMs?: number } = {},
): Promise<SentActivityRepairSummary | null> {
  const db = getSupabaseAdmin();
  if (!db) return null;
  const batchSize = options.batchSize ?? 50;
  const maxBatches = options.maxBatches ?? 4;
  const deadline = Date.now() + (options.budgetMs ?? 10_000);
  const summary: SentActivityRepairSummary = { checked: 0, created: 0, existing: 0, notOwed: 0, failed: 0, errors: 0 };

  for (let batch = 0; batch < maxBatches && Date.now() < deadline; batch += 1) {
    const { data, error } = await db.rpc("repair_email_sent_activities", { p_limit: batchSize });
    if (error || !data || typeof data !== "object") {
      console.error("Email sent activity repair failed:", error?.code ?? "no result");
      summary.errors += 1;
      break;
    }
    const counts = data as Omit<SentActivityRepairSummary, "errors">;
    summary.checked += counts.checked;
    summary.created += counts.created;
    summary.existing += counts.existing;
    summary.notOwed += counts.notOwed;
    summary.failed += counts.failed;
    // A short batch is the last; a batch that settled nothing would only meet the same failing rows again.
    if (counts.checked < batchSize || counts.created + counts.existing + counts.notOwed === 0) break;
  }
  return summary;
}
