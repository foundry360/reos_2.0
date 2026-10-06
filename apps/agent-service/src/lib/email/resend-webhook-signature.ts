import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Resend signs webhooks the Svix way: HMAC-SHA256 over
 * `${id}.${timestamp}.${body}` with the base64 key after the `whsec_` prefix,
 * sent as space-separated `v1,<base64 signature>` entries (more than one
 * during secret rotation). The raw body must be verified before it is parsed.
 */

export const RESEND_WEBHOOK_TOLERANCE_SECONDS = 300;

export interface ResendWebhookHeaders {
  id: string | null;
  timestamp: string | null;
  signature: string | null;
}

/** Svix headers, or their Standard Webhooks names. */
export function resendWebhookHeaders(headers: Headers): ResendWebhookHeaders {
  return {
    id: headers.get("svix-id") ?? headers.get("webhook-id"),
    timestamp: headers.get("svix-timestamp") ?? headers.get("webhook-timestamp"),
    signature: headers.get("svix-signature") ?? headers.get("webhook-signature"),
  };
}

function signingKey(secret: string): Buffer | null {
  const encoded = secret.trim().replace(/^whsec_/, "");
  if (!encoded) return null;
  const key = Buffer.from(encoded, "base64");
  return key.length > 0 ? key : null;
}

export function signResendWebhook(secret: string, id: string, timestamp: string, body: string): string {
  const key = signingKey(secret);
  if (!key) throw new Error("Invalid webhook secret");
  return createHmac("sha256", key).update(`${id}.${timestamp}.${body}`).digest("base64");
}

export function verifyResendWebhook(params: {
  secret: string;
  headers: ResendWebhookHeaders;
  body: string;
  nowSeconds?: number;
}): boolean {
  const { id, timestamp, signature } = params.headers;
  if (!id || !timestamp || !signature) return false;
  if (!/^\d{1,12}$/.test(timestamp)) return false;
  const now = params.nowSeconds ?? Math.floor(Date.now() / 1000);
  if (Math.abs(now - Number(timestamp)) > RESEND_WEBHOOK_TOLERANCE_SECONDS) return false;

  const key = signingKey(params.secret);
  if (!key) return false;
  const expected = createHmac("sha256", key).update(`${id}.${timestamp}.${params.body}`).digest();

  for (const entry of signature.split(" ")) {
    const [version, value] = entry.split(",", 2);
    if (version !== "v1" || !value) continue;
    const candidate = Buffer.from(value, "base64");
    if (candidate.length === expected.length && timingSafeEqual(candidate, expected)) return true;
  }
  return false;
}
