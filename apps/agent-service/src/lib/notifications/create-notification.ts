import { createClient } from "@/lib/supabase/server";
import { getSupabaseAdmin } from "@/lib/supabase/admin";
import type { NotificationCategory } from "./types";
import { getNotificationPreferences } from "./notifications";
import { notifyMembers, prefEnabled, type NotifyMembersInput } from "./notify-members";

export type CreateNotificationInput = {
  userId: string;
  tenantId?: string | null;
  category: NotificationCategory;
  title: string;
  body?: string | null;
  href?: string | null;
};

/** Best-effort insert via the signed-in user session; never throws into CRM flows. */
export async function createUserNotification(
  input: CreateNotificationInput,
): Promise<void> {
  try {
    const prefs = await getNotificationPreferences(input.userId);
    if (!prefEnabled(input.category, prefs)) return;

    const supabase = await createClient();
    const { error } = await supabase.from("user_notifications").insert({
      user_id: input.userId,
      tenant_id: input.tenantId ?? null,
      category: input.category,
      title: input.title,
      body: input.body?.trim() || null,
      href: input.href?.trim() || null,
    });

    if (error) {
      const missing = /user_notifications|schema cache|relation/i.test(error.message);
      if (!missing) {
        console.error("createUserNotification failed:", error.message);
      }
    }
  } catch (error) {
    console.error("createUserNotification failed:", error);
  }
}

/**
 * Notify tenant members (all, or the given members) respecting each member's
 * category preference. Uses the service role so webhook / intake / automation
 * paths work without a user session. Returns how many notifications were created.
 */
export async function notifyTenantMembers(input: NotifyMembersInput): Promise<number> {
  const db = getSupabaseAdmin();
  if (!db) return 0;

  try {
    const result = await notifyMembers(db, input);
    if (result.status === "failed") {
      const missing = result.operation === "insert" && /user_notifications|schema cache|relation/i.test(result.error);
      if (!missing) console.error(`notifyTenantMembers ${result.operation} failed:`, result.error);
    }
    return result.status === "notified" ? result.count : 0;
  } catch (error) {
    console.error("notifyTenantMembers failed:", error);
    return 0;
  }
}

/** Notify every tenant member about a new lead (respecting lead prefs). */
export async function notifyTenantNewLead(input: {
  tenantId: string;
  contactId: string;
  firstName?: string | null;
  lastName?: string | null;
  channel?: "sms" | "messenger" | "instagram";
}): Promise<void> {
  const displayName =
    [input.firstName?.trim(), input.lastName?.trim()].filter(Boolean).join(" ") ||
    "Unknown";

  const channelLabel =
    input.channel === "instagram"
      ? "Instagram"
      : input.channel === "messenger"
        ? "Messenger"
        : input.channel === "sms"
          ? "SMS"
          : null;

  await notifyTenantMembers({
    tenantId: input.tenantId,
    category: "leads",
    title: `New lead: ${displayName}`,
    body: channelLabel ? `Via ${channelLabel}` : null,
    href: `/leads/${input.contactId}`,
  });
}
