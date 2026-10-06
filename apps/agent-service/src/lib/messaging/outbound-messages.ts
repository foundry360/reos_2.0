import type { OutboundOutcome } from "@/lib/messaging/provider-outcome";
import { getSupabaseAdmin } from "@/lib/supabase/admin";

/**
 * Outbound message rows as a record of each send (migration 064). The row is
 * written as pending before the provider is called, so a crash never leaves a
 * row that claims "sent", and then gets the provider's answer.
 *
 * With an idempotency key (one per journey step), the row is the logical send:
 * a retry finds it. A sent row is returned instead of sending again; a pending
 * or unknown row is reported as unresolved and never resent; only a rejected
 * (failed) row is claimed back to pending for another attempt.
 */

export type OutboundAttempt =
  | { status: "ready"; messageId: string }
  | { status: "already_sent"; messageId: string; providerMessageId: string | null }
  | { status: "unresolved"; messageId: string }
  | { status: "error"; error: string };

const MAX_ERROR_LENGTH = 500;

export async function beginOutboundMessage(params: {
  tenantId: string;
  contactId: string;
  channel: string;
  body: string;
  playbook?: string | null;
  idempotencyKey?: string | null;
}): Promise<OutboundAttempt> {
  const db = getSupabaseAdmin();
  if (!db) return { status: "error", error: "Message storage is not configured." };
  const key = params.idempotencyKey?.trim() || null;

  const { data, error } = await db
    .from("messages")
    .insert({
      tenant_id: params.tenantId,
      contact_id: params.contactId,
      channel: params.channel,
      direction: "outbound",
      body: params.body,
      playbook: params.playbook ?? null,
      send_status: "pending",
      idempotency_key: key,
    })
    .select("id")
    .single();
  if (!error && data?.id) return { status: "ready", messageId: data.id };
  if (error?.code !== "23505" || !key) {
    console.error("Outbound message record error:", error?.code ?? "no row");
    return { status: "error", error: "The message couldn't be recorded, so it wasn't sent." };
  }

  const existing = async () => {
    const { data: row, error: readError } = await db
      .from("messages")
      .select("id, send_status, provider_message_id")
      .eq("tenant_id", params.tenantId)
      .eq("idempotency_key", key)
      .maybeSingle();
    if (readError || !row) return null;
    return row as { id: string; send_status: string | null; provider_message_id: string | null };
  };

  let row = await existing();
  if (row?.send_status === "failed") {
    const { data: claimed } = await db
      .from("messages")
      .update({
        send_status: "pending",
        send_error: null,
        body: params.body,
        created_at: new Date().toISOString(),
      })
      .eq("tenant_id", params.tenantId)
      .eq("id", row.id)
      .eq("send_status", "failed")
      .select("id");
    if ((claimed?.length ?? 0) > 0) return { status: "ready", messageId: row.id };
    row = await existing();
  }
  if (!row) return { status: "error", error: "The earlier attempt at this message couldn't be read, so it wasn't sent." };
  if (row.send_status === "sent") {
    return { status: "already_sent", messageId: row.id, providerMessageId: row.provider_message_id };
  }
  return { status: "unresolved", messageId: row.id };
}

/**
 * Records the provider's answer for an agent reply the agent loop stored as
 * pending. Nothing to record when the reply wasn't stored on a contact.
 */
export async function recordReplyOutcome(
  tenantId: string | undefined,
  messageId: string | null | undefined,
  outcome: OutboundOutcome,
): Promise<void> {
  if (!tenantId || !messageId) return;
  await recordOutboundOutcome({ tenantId, messageId, outcome }).catch((error) => {
    console.error("Agent reply outcome error:", error instanceof Error ? error.message : error);
  });
}

/**
 * Records the provider's answer on a pending row. Returns false when it couldn't
 * be recorded; the row then stays pending, which reads as unconfirmed, never sent.
 */
export async function recordOutboundOutcome(params: {
  tenantId: string;
  messageId: string;
  outcome: OutboundOutcome;
}): Promise<boolean> {
  const db = getSupabaseAdmin();
  if (!db) return false;
  const { outcome } = params;
  const update = (values: Record<string, unknown>) =>
    db
      .from("messages")
      .update(values)
      .eq("tenant_id", params.tenantId)
      .eq("id", params.messageId)
      .eq("send_status", "pending")
      .select("id");

  let { data, error } =
    outcome.status === "sent"
      ? await update({ send_status: "sent", provider_message_id: outcome.providerMessageId, send_error: null })
      : await update({ send_status: outcome.status, send_error: outcome.error.slice(0, MAX_ERROR_LENGTH) });

  // The provider id is unique per tenant and channel. A repeat is recorded as sent without it, never dropped.
  if (error?.code === "23505" && outcome.status === "sent") {
    ({ data, error } = await update({
      send_status: "sent",
      provider_message_id: null,
      send_error: "The provider returned a message id already recorded on another message.",
    }));
  }
  if (error || (data?.length ?? 0) === 0) {
    console.error("Outbound message outcome not recorded:", error?.code ?? "no pending row", outcome.status);
    return false;
  }
  return true;
}
