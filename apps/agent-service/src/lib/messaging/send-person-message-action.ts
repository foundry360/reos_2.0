"use server";

import { revalidatePath } from "next/cache";
import { personBasePath, type PersonKind } from "@/lib/crm/person-kind";
import { deliverMessageToContact, type MessagingChannel } from "@/lib/messaging/deliver-message";
import { createClient } from "@/lib/supabase/server";
import { resolveCurrentTenant } from "@/lib/tenant/current-tenant";

export type { MessagingChannel };

export interface SendPersonMessageResult {
  ok: boolean;
  error?: string;
  messageId?: string;
}

export async function sendPersonMessageAction(input: {
  contactId: string;
  channel: MessagingChannel;
  body: string;
}): Promise<SendPersonMessageResult> {
  const body = input.body.trim();
  if (!body) return { ok: false, error: "Message cannot be empty." };
  if (body.length > 2000) return { ok: false, error: "Message is too long." };

  const { tenantId } = await resolveCurrentTenant();
  if (!tenantId) {
    return { ok: false, error: "Your account is not linked to a workspace yet." };
  }

  const supabase = await createClient();
  const result = await deliverMessageToContact(supabase, {
    tenantId,
    contactId: input.contactId,
    channel: input.channel,
    body,
  });
  if (!result.ok) return { ok: false, error: result.error };

  const kind: PersonKind = result.recordType === "contact" ? "contact" : "lead";
  revalidatePath(`${personBasePath(kind)}/${input.contactId}`);

  return { ok: true, messageId: result.messageId ?? undefined };
}
