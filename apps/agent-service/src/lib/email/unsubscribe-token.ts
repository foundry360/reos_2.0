/**
 * Signed unsubscribe links for automated (journey) email. The token is
 * `<contact id>.<signature>`: the contact id says whose link it is, and the
 * HMAC binds it to the contact's tenant without putting the tenant in the URL.
 * Links don't expire; an unsubscribe link has to keep working.
 *
 * Pure module (no `@/` imports) so it runs under node --test.
 */

import { createHmac, timingSafeEqual } from "node:crypto";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The signing secret. Production requires EMAIL_UNSUBSCRIBE_SECRET and gets null
 * without it (no links are made and none are accepted). Development and tests
 * fall back to the platform encryption key, then the service role key, each used
 * only as an HMAC key and separated from its other uses by the message prefix.
 *
 * Rotation: there is one active secret and no key list. Changing it invalidates
 * every unsubscribe link already sent; people with an old link get "isn't valid"
 * and must use the link from a newer email.
 */
export function unsubscribeSecret(env: Record<string, string | undefined> = process.env): string | null {
  const configured = env.EMAIL_UNSUBSCRIBE_SECRET?.trim();
  if (configured) return configured;
  if (env.NODE_ENV === "production") return null;
  return env.PLATFORM_SECRETS_ENCRYPTION_KEY?.trim() || env.SUPABASE_SERVICE_ROLE_KEY?.trim() || null;
}

function signature(secret: string, tenantId: string, contactId: string): Buffer {
  return createHmac("sha256", secret).update(`reos-email-unsubscribe:v1:${tenantId}:${contactId.toLowerCase()}`).digest();
}

export function signUnsubscribeToken(secret: string, tenantId: string, contactId: string): string {
  return `${contactId.toLowerCase()}.${signature(secret, tenantId, contactId).toString("base64url")}`;
}

/** The contact id a token claims, or null when it isn't shaped like a token. Not yet verified. */
export function unsubscribeTokenContactId(token: string): string | null {
  const [contactId, sig, extra] = token.split(".");
  if (extra !== undefined || !sig || !contactId || !UUID.test(contactId)) return null;
  return contactId.toLowerCase();
}

export function verifyUnsubscribeToken(secret: string, token: string, tenantId: string): boolean {
  const contactId = unsubscribeTokenContactId(token);
  if (!contactId) return false;
  const actual = Buffer.from(token.split(".")[1], "base64url");
  const expected = signature(secret, tenantId, contactId);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}
