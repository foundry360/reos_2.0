/**
 * The manual composer's draft identity and what it does after a send. Pure
 * module (relative imports only) so it runs under node --test and in the browser.
 *
 * A draft identity names one message the operator means to send: the server
 * uses it as the send's idempotency key, so a double submit or a retry of the
 * same draft is the same operation. It is bound to the content it was first
 * submitted with; new content needs a new identity.
 */

import type { OutboundSendStatus } from "./send-status-label.ts";

export type ComposeSendResult =
  | { outcome: "sent"; messageId: string | null }
  /** The provider rejected it (the record is failed): retry is safe. */
  | { outcome: "not_sent"; error: string; messageId: string }
  /** The record is pending or unknown: it may have been sent, and is never resent automatically. */
  | { outcome: "not_confirmed"; error: string; messageId: string; sendStatus: "pending" | "unknown" }
  /** Nothing was recorded or sent (consent, channel, or configuration). */
  | { outcome: "not_attempted"; error: string }
  /** This draft identity was already used for different content. */
  | { outcome: "draft_conflict"; error: string };

export interface DraftIdentity {
  id: string;
  /** The content this identity was submitted with; null until its first send. */
  submitted: string | null;
}

export function newDraftIdentity(id: string): DraftIdentity {
  return { id, submitted: null };
}

/** The identity to send `content` under: the current one, unless it was already submitted with other content. */
export function identityForSend(current: DraftIdentity, content: string, freshId: () => string): DraftIdentity {
  if (current.submitted !== null && current.submitted !== content) return { id: freshId(), submitted: content };
  return { id: current.id, submitted: content };
}

/** The composer content a draft identity is bound to: the channel and the text. */
export function draftContent(channel: string, body: string): string {
  return `${channel}\n${body}`;
}

export interface ComposerAfterSend {
  /** "restore": put the text back to edit or retry. "clear": leave the composer empty. */
  draft: "restore" | "clear";
  /** Start a new draft identity for the next message. */
  newIdentity: boolean;
  /** The message bubble: shown with its stored status (keeping the optimistic one when the id isn't known), or removed when nothing was recorded. */
  bubble: { status: OutboundSendStatus; messageId: string | null } | null;
  notice: string | null;
}

export const NOT_CONFIRMED_NOTICE =
  "Not confirmed: this message may have been sent. Check with them before sending it again.";

export function composerAfterSend(result: ComposeSendResult): ComposerAfterSend {
  switch (result.outcome) {
    case "sent":
      return { draft: "clear", newIdentity: true, bubble: { status: "sent", messageId: result.messageId }, notice: null };
    case "not_sent":
      return {
        draft: "restore",
        newIdentity: false,
        bubble: { status: "failed", messageId: result.messageId },
        notice: `Not sent: ${result.error}`,
      };
    case "not_confirmed":
      // The text stays visible in the thread; it isn't put back as a draft ready to send again.
      return {
        draft: "clear",
        newIdentity: true,
        bubble: { status: result.sendStatus, messageId: result.messageId },
        notice: NOT_CONFIRMED_NOTICE,
      };
    case "not_attempted":
      return { draft: "restore", newIdentity: false, bubble: null, notice: result.error };
    case "draft_conflict":
      return { draft: "restore", newIdentity: true, bubble: null, notice: result.error };
  }
}
