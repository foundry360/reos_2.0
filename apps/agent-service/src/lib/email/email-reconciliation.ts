import { applyProviderEvent } from "@/lib/email/email-provider-events";
import { retrieveResendEmail } from "@/lib/email/resend";
import { getSupabaseAdmin } from "@/lib/supabase/admin";

/**
 * Sweeps outbound Resend emails stuck pending or unknown (migration 066). It
 * never sends, resends or creates an email: it only settles a row from
 * Resend's authoritative record of that exact email, or records that REOS
 * still can't tell.
 *
 * - With a Resend id on the row: Resend's record (GET /emails/{id}) is applied
 *   through the same database function as webhook events.
 * - Pending with no evidence 15 minutes on: REOS never recorded Resend's
 *   answer, so the row becomes unknown (still never resent).
 * - Unknown with no evidence: stays unknown, rechecked after 1h, 6h, then
 *   daily, until 7 days after it was created.
 *
 * Rows are leased by claim_email_reconciliation (FOR UPDATE SKIP LOCKED), so
 * concurrent sweepers never take the same row, and every change is conditional
 * on the status it was claimed in, so a webhook settling the row first wins.
 */

export const PENDING_NOT_RECORDED_ERROR =
  "REOS never recorded Resend's answer to this email, so it isn't confirmed; it may have been sent. It won't be sent again.";

const UNKNOWN_RECHECK_HOURS = [1, 6, 24];
const RECONCILE_WINDOW_DAYS = 7;
const LEASE_SECONDS = 300;
const PROVIDER_EVENT_RETENTION_DAYS = 90;

/** Resend's last_event values that prove it accepted the email, as the event they correspond to. */
const LAST_EVENT_AS_EVENT: Record<string, string> = {
  queued: "email.sent",
  scheduled: "email.sent",
  sent: "email.sent",
  opened: "email.sent",
  clicked: "email.sent",
  delivered: "email.delivered",
  delivery_delayed: "email.delivery_delayed",
  bounced: "email.bounced",
  complained: "email.complained",
  failed: "email.failed",
  suppressed: "email.suppressed",
};

interface ClaimedEmail {
  id: string;
  tenant_id: string;
  status: "pending" | "unknown";
  provider_message_id: string | null;
  reconcile_attempts: number;
  created_at: string;
}

export interface EmailReconciliationSummary {
  claimed: number;
  /** Settled from Resend's record. */
  resolved: number;
  /** Pending rows whose outcome was never recorded, now unknown. */
  markedUnknown: number;
  stillUnknown: number;
  /** Unknown rows past the reconciliation window; no longer checked. */
  retired: number;
  /** Rows a webhook or another worker settled while this one held them. */
  settledElsewhere: number;
  errors: number;
  purgedEvents: number;
}

export function nextUnknownCheck(attempts: number, createdAt: string, now: number): string | null {
  const hours = UNKNOWN_RECHECK_HOURS[Math.min(Math.max(attempts, 1), UNKNOWN_RECHECK_HOURS.length) - 1];
  const next = now + hours * 3_600_000;
  const created = Date.parse(createdAt);
  if (Number.isNaN(created) || next > created + RECONCILE_WINDOW_DAYS * 86_400_000) return null;
  return new Date(next).toISOString();
}

type Disposition = "resolved" | "markedUnknown" | "stillUnknown" | "retired" | "settledElsewhere" | "error";

async function resolveFromProvider(row: ClaimedEmail): Promise<"resolved" | "unresolved" | "error"> {
  if (!row.provider_message_id) return "unresolved";
  const record = await retrieveResendEmail(row.provider_message_id);
  if (record.status !== "found") return "unresolved";
  // Resend's record must be this email: a tag naming another row is no evidence.
  if (record.reosEmailId && record.reosEmailId !== row.id) return "unresolved";
  const type = record.lastEvent ? LAST_EVENT_AS_EVENT[record.lastEvent] : undefined;
  if (!type) return "unresolved";
  const applied = await applyProviderEvent({
    eventId: `retrieval:${row.id}:${record.lastEvent}`,
    type,
    providerMessageId: row.provider_message_id,
    reosEmailId: row.id,
    eventAt: null,
    detail: { source: "retrieval" },
  });
  if (!applied.ok) return "error";
  return applied.result === "applied" ? "resolved" : "unresolved";
}

async function reconcileOne(row: ClaimedEmail, now: number): Promise<Disposition> {
  const db = getSupabaseAdmin();
  if (!db) return "error";
  const fromProvider = await resolveFromProvider(row);
  if (fromProvider === "resolved") return "resolved";
  if (fromProvider === "error") return "error";

  if (row.status === "pending") {
    const { data, error } = await db
      .from("crm_emails")
      .update({ status: "unknown", send_error: PENDING_NOT_RECORDED_ERROR })
      .eq("tenant_id", row.tenant_id)
      .eq("id", row.id)
      .eq("status", "pending")
      .select("id");
    if (error) return "error";
    return (data?.length ?? 0) > 0 ? "markedUnknown" : "settledElsewhere";
  }

  const next = nextUnknownCheck(row.reconcile_attempts, row.created_at, now);
  const { data, error } = await db
    .from("crm_emails")
    .update({ reconcile_after: next })
    .eq("tenant_id", row.tenant_id)
    .eq("id", row.id)
    .eq("status", "unknown")
    .select("id");
  if (error) return "error";
  if ((data?.length ?? 0) === 0) return "settledElsewhere";
  return next ? "stillUnknown" : "retired";
}

export async function reconcileOutboundEmails(
  options: { batchSize?: number; maxBatches?: number; budgetMs?: number } = {},
): Promise<EmailReconciliationSummary | null> {
  const db = getSupabaseAdmin();
  if (!db) return null;
  const batchSize = options.batchSize ?? 25;
  const maxBatches = options.maxBatches ?? 4;
  const deadline = Date.now() + (options.budgetMs ?? 20_000);
  const summary: EmailReconciliationSummary = {
    claimed: 0,
    resolved: 0,
    markedUnknown: 0,
    stillUnknown: 0,
    retired: 0,
    settledElsewhere: 0,
    errors: 0,
    purgedEvents: 0,
  };

  for (let batch = 0; batch < maxBatches && Date.now() < deadline; batch += 1) {
    const { data, error } = await db.rpc("claim_email_reconciliation", {
      p_limit: batchSize,
      p_lease_seconds: LEASE_SECONDS,
    });
    if (error) {
      console.error("Email reconciliation claim failed:", error.code ?? "unknown");
      summary.errors += 1;
      break;
    }
    const rows = (data ?? []) as ClaimedEmail[];
    summary.claimed += rows.length;
    for (const row of rows) {
      const disposition = await reconcileOne(row, Date.now());
      if (disposition === "error") summary.errors += 1;
      else summary[disposition] += 1;
    }
    if (rows.length < batchSize) break;
  }

  const { data: purged, error: purgeError } = await db.rpc("purge_email_provider_events", {
    p_older_than_days: PROVIDER_EVENT_RETENTION_DAYS,
  });
  if (purgeError) summary.errors += 1;
  else summary.purgedEvents = typeof purged === "number" ? purged : 0;
  return summary;
}
