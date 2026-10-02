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

export type MetaCommentPlatform = "facebook" | "instagram";

export interface MetaCommentEvent {
  platform: MetaCommentPlatform;
  /** Facebook Page id or Instagram professional account id (webhook entry.id). */
  accountId: string;
  commentId: string;
  postId: string | null;
  /** Set when the comment replies to another comment rather than the post. */
  parentCommentId: string | null;
  commenterId: string;
  /** Facebook display name or Instagram username. */
  commenterName: string | null;
  text: string;
}

interface ChangeEvent {
  field?: string;
  value?: {
    item?: string;
    verb?: string;
    comment_id?: string;
    post_id?: string;
    parent_id?: string;
    message?: string;
    from?: { id?: string; name?: string; username?: string };
    id?: string;
    text?: string;
    media?: { id?: string };
  };
}

interface WebhookEntry {
  id?: string;
  messaging?: MessagingEvent[];
  changes?: ChangeEvent[];
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

function trimmed(value: string | undefined): string | null {
  const next = value?.trim();
  return next ? next : null;
}

/**
 * New comments on Facebook Page posts (`feed`) and Instagram media (`comments`).
 * Comments written by the Page / IG account itself are dropped so replies never loop.
 */
export function parseMetaCommentEvents(payload: unknown): MetaCommentEvent[] {
  const body = payload as WebhookPayload;
  const object = body.object?.trim();
  if (object !== "page" && object !== "instagram") return [];

  const events: MetaCommentEvent[] = [];

  for (const entry of body.entry ?? []) {
    const accountId = entry.id?.trim() ?? "";
    if (!accountId) continue;

    for (const change of entry.changes ?? []) {
      const value = change.value;
      if (!value) continue;

      if (object === "page") {
        if (change.field !== "feed" || value.item !== "comment" || value.verb !== "add") continue;
        const commentId = trimmed(value.comment_id);
        const commenterId = trimmed(value.from?.id);
        if (!commentId || !commenterId || commenterId === accountId) continue;
        const postId = trimmed(value.post_id);
        const parentId = trimmed(value.parent_id);
        events.push({
          platform: "facebook",
          accountId,
          commentId,
          postId,
          // Top-level Facebook comments report the post as their parent.
          parentCommentId: parentId && parentId !== postId ? parentId : null,
          commenterId,
          commenterName: trimmed(value.from?.name),
          text: value.message?.trim() ?? "",
        });
        continue;
      }

      if (change.field !== "comments") continue;
      const commentId = trimmed(value.id);
      const commenterId = trimmed(value.from?.id);
      if (!commentId || !commenterId || commenterId === accountId) continue;
      events.push({
        platform: "instagram",
        accountId,
        commentId,
        postId: trimmed(value.media?.id),
        parentCommentId: trimmed(value.parent_id),
        commenterId,
        commenterName: trimmed(value.from?.username),
        text: value.text?.trim() ?? "",
      });
    }
  }

  return events;
}
