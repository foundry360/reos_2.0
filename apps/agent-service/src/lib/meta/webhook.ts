import { createHmac, timingSafeEqual } from "crypto";
import { getEnv } from "@/lib/env";

export type MetaMessagingChannel = "messenger" | "instagram";

export interface MetaWebhookMessage {
  channel: MetaMessagingChannel;
  pageOrAccountId: string;
  /** End-user PSID / IGSID (the contact), whether inbound or echo. */
  contactExternalId: string;
  direction: "inbound" | "outbound";
  text: string;
  mid: string | null;
}

/** @deprecated Use MetaWebhookMessage */
export type MetaInboundMessage = MetaWebhookMessage;

interface MessagingEvent {
  sender?: { id?: string };
  recipient?: { id?: string };
  message?: {
    mid?: string;
    text?: string;
    is_echo?: boolean;
  };
}

interface WebhookEntry {
  id?: string;
  messaging?: MessagingEvent[];
}

interface WebhookPayload {
  object?: string;
  entry?: WebhookEntry[];
}

export function verifyMetaWebhookSignature(rawBody: string, signatureHeader: string | null): boolean {
  const env = getEnv();
  if (!env.META_APP_SECRET) return false;
  if (!signatureHeader?.startsWith("sha256=")) return false;

  const expected = createHmac("sha256", env.META_APP_SECRET).update(rawBody, "utf8").digest("hex");
  const provided = signatureHeader.slice("sha256=".length);

  try {
    const expectedBuf = Buffer.from(expected, "utf8");
    const providedBuf = Buffer.from(provided, "utf8");
    if (expectedBuf.length !== providedBuf.length) return false;
    return timingSafeEqual(expectedBuf, providedBuf);
  } catch {
    return false;
  }
}

export function parseMetaWebhookPayload(payload: unknown): MetaWebhookMessage[] {
  const body = payload as WebhookPayload;
  const object = body.object?.trim();
  if (object !== "page" && object !== "instagram") return [];

  const channel: MetaMessagingChannel = object === "instagram" ? "instagram" : "messenger";
  const messages: MetaWebhookMessage[] = [];

  for (const entry of body.entry ?? []) {
    const pageOrAccountId = entry.id?.trim() ?? "";
    for (const event of entry.messaging ?? []) {
      const text = event.message?.text?.trim() ?? "";
      const senderId = event.sender?.id?.trim() ?? "";
      const recipientId = event.recipient?.id?.trim() ?? "";
      if (!pageOrAccountId || !text) continue;

      const isEcho = Boolean(event.message?.is_echo);
      // Echo: Page → user. Inbound: user → Page.
      const contactExternalId = isEcho ? recipientId : senderId;
      if (!contactExternalId) continue;

      messages.push({
        channel,
        pageOrAccountId,
        contactExternalId,
        direction: isEcho ? "outbound" : "inbound",
        text,
        mid: event.message?.mid?.trim() || null,
      });
    }
  }

  return messages;
}
