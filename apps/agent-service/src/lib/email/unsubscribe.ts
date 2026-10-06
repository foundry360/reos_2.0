import type { SupabaseClient } from "@supabase/supabase-js";
import { getPublicSiteUrl } from "@/lib/calendar/meeting-join";
import { logSystemContactActivity } from "@/lib/crm/log-system-activity";
import {
  signUnsubscribeToken,
  unsubscribeSecret,
  unsubscribeTokenContactId,
  verifyUnsubscribeToken,
} from "@/lib/email/unsubscribe-token";
import { getSupabaseAdmin } from "@/lib/supabase/admin";

export const UNSUBSCRIBE_PATH = "/api/email/unsubscribe";

/**
 * What an automated email carries so its recipient can stop automated email:
 * a footer link and RFC 8058 one-click List-Unsubscribe headers. Null when no
 * link can be built (no signing secret, or no public site URL in production);
 * the caller must not send automated email without one.
 */
export function automatedEmailUnsubscribe(
  tenantId: string,
  contactId: string,
): { url: string; headers: Record<string, string>; footerHtml: string } | null {
  const secret = unsubscribeSecret();
  if (!secret) return null;
  if (process.env.NODE_ENV === "production" && !process.env.NEXT_PUBLIC_SITE_URL?.trim()) return null;
  const token = signUnsubscribeToken(secret, tenantId, contactId);
  const url = `${getPublicSiteUrl()}${UNSUBSCRIBE_PATH}?token=${encodeURIComponent(token)}`;
  return {
    url,
    headers: {
      "List-Unsubscribe": `<${url}>`,
      "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
    },
    footerHtml: `<p style="color:#6b7280;font-size:12px;margin-top:24px">Don't want these emails? <a href="${url}">Unsubscribe</a>.</p>`,
  };
}

export type UnsubscribeResult = "unsubscribed" | "invalid" | "error";

/**
 * Applies an unsubscribe link: sets contacts.email_unsubscribed_at for the
 * token's contact, in the tenant the signature was made for. Repeat clicks keep
 * the first time. "error" means nothing was recorded and the person should try again.
 */
export async function unsubscribeFromAutomatedEmail(token: string): Promise<UnsubscribeResult> {
  const secret = unsubscribeSecret();
  if (!secret) {
    console.error("Email unsubscribe is not configured: EMAIL_UNSUBSCRIBE_SECRET is required in production.");
    return "error";
  }
  const contactId = unsubscribeTokenContactId(token);
  if (!contactId) return "invalid";
  const db = getSupabaseAdmin();
  if (!db) return "error";

  const { data: contact, error } = await db
    .from("contacts")
    .select("id, tenant_id, email_unsubscribed_at")
    .eq("id", contactId)
    .maybeSingle<{ id: string; tenant_id: string; email_unsubscribed_at: string | null }>();
  if (error) return "error";
  if (!contact || !verifyUnsubscribeToken(secret, token, contact.tenant_id)) return "invalid";
  if (contact.email_unsubscribed_at) return "unsubscribed";

  const { data: updated, error: updateError } = await db
    .from("contacts")
    .update({ email_unsubscribed_at: new Date().toISOString() })
    .eq("id", contact.id)
    .eq("tenant_id", contact.tenant_id)
    .select("id");
  if (updateError || (updated?.length ?? 0) === 0) return "error";

  await logSystemContactActivity({
    tenantId: contact.tenant_id,
    contactId: contact.id,
    activityType: "contact",
    title: "Unsubscribed from automated email",
    body: "They used the unsubscribe link in a journey email. REOS won't send them email, from journeys or from the team.",
  }).catch(() => undefined);
  return "unsubscribed";
}

/**
 * Whether a team email (CRM compose, conversational: see email-purpose.ts) may
 * go out: an email unsubscribe covers it. Blocked when the linked contact, or any contact in the tenant whose
 * address is a recipient (to or cc), has unsubscribed. A failed check blocks.
 */
export async function manualEmailUnsubscribeBlock(
  db: SupabaseClient,
  params: { tenantId: string; contactId: string | null; emails: string[] },
): Promise<{ blocked: false } | { blocked: true; error: string }> {
  const failed = { blocked: true as const, error: "Couldn't check email unsubscribes, so the email wasn't sent." };
  if (params.contactId) {
    const { data, error } = await db
      .from("contacts")
      .select("email_unsubscribed_at")
      .eq("id", params.contactId)
      .eq("tenant_id", params.tenantId)
      .maybeSingle<{ email_unsubscribed_at: string | null }>();
    if (error) return failed;
    if (data?.email_unsubscribed_at) {
      return { blocked: true, error: "This person unsubscribed from email, so the email wasn't sent." };
    }
  }
  for (const email of new Set(params.emails.map((address) => address.trim().toLowerCase()).filter(Boolean))) {
    const { data, error } = await db
      .from("contacts")
      .select("id")
      .eq("tenant_id", params.tenantId)
      .not("email_unsubscribed_at", "is", null)
      .ilike("email", email.replace(/[\\%_]/g, (char) => `\\${char}`))
      .limit(1);
    if (error) return failed;
    if ((data?.length ?? 0) > 0) {
      return { blocked: true, error: `${email} unsubscribed from email, so the email wasn't sent.` };
    }
  }
  return { blocked: false };
}
