import { createHmac, timingSafeEqual } from "crypto";
import { getEnv } from "@/lib/env";

export type MetaMessagingChannel = "messenger" | "instagram";

export interface MetaInboundMessage {
  channel: MetaMessagingChannel;
  pageOrAccountId: string;
  senderId: string;
  text: string;
  mid: string | null;
}

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

export function parseMetaWebhookPayload(payload: unknown): MetaInboundMessage[] {
  const body = payload as WebhookPayload;
  const object = body.object?.trim();
  if (object !== "page" && object !== "instagram") return [];

  const channel: MetaMessagingChannel = object === "instagram" ? "instagram" : "messenger";
  const messages: MetaInboundMessage[] = [];

  for (const entry of body.entry ?? []) {
    const pageOrAccountId = entry.id?.trim() ?? "";
    for (const event of entry.messaging ?? []) {
      if (event.message?.is_echo) continue;
      const text = event.message?.text?.trim() ?? "";
      const senderId = event.sender?.id?.trim() ?? "";
      if (!pageOrAccountId || !senderId || !text) continue;

      messages.push({
        channel,
        pageOrAccountId,
        senderId,
        text,
        mid: event.message?.mid?.trim() || null,
      });
    }
  }

  return messages;
}
