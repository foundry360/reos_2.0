import { createHash } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { ComposeSendResult } from "@/lib/messaging/compose-draft";
import { deliverMessageToContact, type MessagingChannel } from "@/lib/messaging/deliver-message";

const DRAFT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The idempotency key of one composed message: per user, per draft. */
export function composeOperationKey(userId: string, draftId: string): string {
  return `compose:${userId}:${draftId}`;
}

export function composeContentHash(content: { contactId: string; channel: string; body: string }): string {
  return createHash("sha256").update(JSON.stringify([content.contactId, content.channel, content.body])).digest("hex");
}

type DraftRow = { id: string; contact_id: string; channel: string; body: string; send_status: string | null };

async function draftRecord(db: SupabaseClient, tenantId: string, key: string): Promise<{ row: DraftRow | null } | null> {
  const { data, error } = await db
    .from("messages")
    .select("id, contact_id, channel, body, send_status")
    .eq("tenant_id", tenantId)
    .eq("idempotency_key", key)
    .maybeSingle<DraftRow>();
  return error ? null : { row: data ?? null };
}

const DRAFT_CONFLICT: ComposeSendResult = {
  outcome: "draft_conflict",
  error: "This draft was already used for a different message, so it wasn't sent. Send it again as a new message.",
};

/**
 * A manual SMS / Messenger / Instagram message from the composer, as one
 * operation named by its draft: the same draft and content are the same send
 * (a sent message isn't sent again, a failed one is retried, a pending or
 * unknown one is never resent), and a draft already used for other content is
 * refused. Consent and channel rules are deliverMessageToContact's, unchanged.
 */
export async function sendComposedMessage(
  db: SupabaseClient,
  input: { tenantId: string; userId: string; contactId: string; channel: MessagingChannel; body: string; draftId: string },
): Promise<ComposeSendResult> {
  if (!DRAFT_ID.test(input.draftId)) {
    return { outcome: "not_attempted", error: "This draft couldn't be identified, so it wasn't sent. Refresh the page and try again." };
  }
  const key = composeOperationKey(input.userId, input.draftId);
  const hash = composeContentHash(input);
  const matches = (row: DraftRow) =>
    composeContentHash({ contactId: row.contact_id, channel: row.channel, body: row.body }) === hash;

  const before = await draftRecord(db, input.tenantId, key);
  if (!before) return { outcome: "not_attempted", error: "Couldn't check this draft, so the message wasn't sent." };
  if (before.row && !matches(before.row)) return DRAFT_CONFLICT;

  const result = await deliverMessageToContact(db, {
    tenantId: input.tenantId,
    contactId: input.contactId,
    channel: input.channel,
    body: input.body,
    idempotencyKey: key,
  });

  // The record this draft has now, which is what the thread shows after a reload.
  const after = await draftRecord(db, input.tenantId, key);
  const row = after?.row ?? null;
  if (row && !matches(row)) return DRAFT_CONFLICT;
  if (result.ok) return { outcome: "sent", messageId: result.messageId ?? row?.id ?? null };
  if (!row) return { outcome: "not_attempted", error: result.error };
  const { error } = result;
  switch (row.send_status) {
    case "sent":
      return { outcome: "sent", messageId: row.id };
    case "failed":
      return { outcome: "not_sent", error, messageId: row.id };
    case "pending":
      return { outcome: "not_confirmed", error, messageId: row.id, sendStatus: "pending" };
    default:
      return { outcome: "not_confirmed", error, messageId: row.id, sendStatus: "unknown" };
  }
}
