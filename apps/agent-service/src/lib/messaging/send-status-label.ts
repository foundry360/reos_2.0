/**
 * How an outbound message or email's send status reads to an operator. Pure
 * module (relative imports only) so it runs under node --test and in the browser.
 *
 * A pending record is only "Sending…" while the provider call could still be in
 * flight. After that it reads "Not confirmed": the outcome was never recorded,
 * so it may or may not have been sent. This is presentation only; the stored
 * status stays pending.
 */

import { PROVIDER_SEND_TIMEOUT_MS } from "./provider-outcome.ts";

export type OutboundSendStatus = "pending" | "sent" | "failed" | "unknown";

/** The provider timeout plus time to record the answer. */
export const PENDING_DISPLAY_WINDOW_MS = PROVIDER_SEND_TIMEOUT_MS + 40_000;

export type SendStatusPresentation = { label: "Sending…" | "Not sent" | "Not confirmed"; problem: boolean };

/** Null for a sent (or legacy, statusless) record, which reads as plainly sent. */
export function presentSendStatus(
  status: OutboundSendStatus | null | undefined,
  createdAt: string | null | undefined,
  now: number,
): SendStatusPresentation | null {
  switch (status) {
    case "failed":
      return { label: "Not sent", problem: true };
    case "unknown":
      return { label: "Not confirmed", problem: true };
    case "pending": {
      const created = createdAt ? Date.parse(createdAt) : Number.NaN;
      return now - created < PENDING_DISPLAY_WINDOW_MS
        ? { label: "Sending…", problem: false }
        : { label: "Not confirmed", problem: true };
    }
    default:
      return null;
  }
}

/** What happened after Resend accepted an email, from its signed events (migration 066). */
export type EmailDeliveryStatus = "delivered" | "delayed" | "bounced" | "complained" | "failed" | "suppressed";

const DELIVERY_STATUSES: readonly string[] = ["delivered", "delayed", "bounced", "complained", "failed", "suppressed"];

export function parseDeliveryStatus(value: unknown): EmailDeliveryStatus | null {
  return typeof value === "string" && DELIVERY_STATUSES.includes(value) ? (value as EmailDeliveryStatus) : null;
}

export type DeliveryStatusPresentation = {
  label: "Delivered" | "Delivery delayed" | "Not delivered (bounced)" | "Not delivered" | "Not delivered (suppressed)" | "Marked as spam";
  problem: boolean;
};

export function presentDeliveryStatus(status: EmailDeliveryStatus | null | undefined): DeliveryStatusPresentation | null {
  switch (status) {
    case "delivered":
      return { label: "Delivered", problem: false };
    case "delayed":
      return { label: "Delivery delayed", problem: false };
    case "bounced":
      return { label: "Not delivered (bounced)", problem: true };
    case "failed":
      return { label: "Not delivered", problem: true };
    case "suppressed":
      return { label: "Not delivered (suppressed)", problem: true };
    case "complained":
      return { label: "Marked as spam", problem: true };
    default:
      return null;
  }
}
