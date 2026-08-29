import { appendMessage, resolveInboundContact } from "@/lib/db/contacts";
import { isSupabaseConfigured } from "@/lib/env";
import type { MetaInboundMessage } from "@/lib/meta/webhook";

export interface HandleMetaInboundResult {
  ok: boolean;
  contactId?: string;
  tenantId?: string;
  skipped?: string;
}

/** Persist an inbound Messenger / Instagram DM (no auto-reply yet). */
export async function handleInboundMetaMessage(
  message: MetaInboundMessage,
): Promise<HandleMetaInboundResult> {
  if (!isSupabaseConfigured()) {
    return { ok: false, skipped: "supabase_not_configured" };
  }

  const ctx = await resolveInboundContact({
    channel: message.channel,
    from: message.senderId,
    to: message.pageOrAccountId,
  });

  const tenantId = ctx.accountId;
  if (!tenantId || tenantId === "default-tenant" || !ctx.contactId) {
    return { ok: false, skipped: "tenant_or_contact_unresolved" };
  }

  await appendMessage({
    tenantId,
    contactId: ctx.contactId,
    channel: message.channel,
    direction: "inbound",
    body: message.text,
  });

  return { ok: true, contactId: ctx.contactId, tenantId };
}
