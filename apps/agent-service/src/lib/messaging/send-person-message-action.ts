"use server";

import { revalidatePath } from "next/cache";
import { personBasePath } from "@/lib/crm/person-kind";
import type { ComposeSendResult } from "@/lib/messaging/compose-draft";
import { sendComposedMessage } from "@/lib/messaging/compose-message";
import type { MessagingChannel } from "@/lib/messaging/deliver-message";
import { createClient } from "@/lib/supabase/server";
import { resolveCurrentTenant } from "@/lib/tenant/current-tenant";

export type { MessagingChannel };

export async function sendPersonMessageAction(input: {
  contactId: string;
  channel: MessagingChannel;
  body: string;
  /** The composer's draft identity: the idempotency boundary of this message. */
  draftId: string;
}): Promise<ComposeSendResult> {
  const body = input.body.trim();
  if (!body) return { outcome: "not_attempted", error: "Message cannot be empty." };
  if (body.length > 2000) return { outcome: "not_attempted", error: "Message is too long." };

  const { tenantId } = await resolveCurrentTenant();
  if (!tenantId) {
    return { outcome: "not_attempted", error: "Your account is not linked to a workspace yet." };
  }

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { outcome: "not_attempted", error: "You're signed out. Sign in and try again." };

  const result = await sendComposedMessage(supabase, {
    tenantId,
    userId: user.id,
    contactId: input.contactId,
    channel: input.channel,
    body,
    draftId: input.draftId,
  });
  if (result.outcome !== "not_attempted" && result.outcome !== "draft_conflict") {
    revalidatePath(`${personBasePath("lead")}/${input.contactId}`);
    revalidatePath(`${personBasePath("contact")}/${input.contactId}`);
  }
  return result;
}
