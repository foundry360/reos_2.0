import { createClient } from "@/lib/supabase/server";
import { getSupabaseAdmin } from "@/lib/supabase/admin";
import {
  DEFAULT_NOTIFICATION_PREFERENCES,
  NOTIFICATION_CATEGORY_META,
  type NotificationCategory,
  type NotificationPreferences,
} from "./types";
import { getNotificationPreferences } from "./notifications";

export type CreateNotificationInput = {
  userId: string;
  tenantId?: string | null;
  category: NotificationCategory;
  title: string;
  body?: string | null;
  href?: string | null;
};

function prefEnabled(
  category: NotificationCategory,
  prefs: NotificationPreferences,
): boolean {
  const meta = NOTIFICATION_CATEGORY_META.find((item) => item.id === category);
  if (!meta) return false;
  return prefs[meta.prefKey];
}

function mapPreferences(row: {
  tasks_in_app: boolean;
  leads_in_app: boolean;
  opportunities_in_app: boolean;
  messages_in_app: boolean;
  system_in_app: boolean;
} | null): NotificationPreferences {
  if (!row) return { ...DEFAULT_NOTIFICATION_PREFERENCES };
  return {
    tasksInApp: row.tasks_in_app,
    leadsInApp: row.leads_in_app,
    opportunitiesInApp: row.opportunities_in_app,
    messagesInApp: row.messages_in_app,
    systemInApp: row.system_in_app,
  };
}

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
 * Notify every tenant member (respecting lead prefs). Uses the service role so
 * webhook / intake paths work without a user session.
 */
export async function notifyTenantNewLead(input: {
  tenantId: string;
  contactId: string;
  firstName?: string | null;
  lastName?: string | null;
  channel?: "sms" | "messenger" | "instagram";
}): Promise<void> {
  const db = getSupabaseAdmin();
  if (!db) return;

  try {
    const { data: members, error: membersError } = await db
      .from("memberships")
      .select("user_id")
      .eq("tenant_id", input.tenantId);

    if (membersError) {
      console.error("notifyTenantNewLead members failed:", membersError.message);
      return;
    }

    const userIds = [
      ...new Set(
        (members ?? [])
          .map((row) => row.user_id?.trim())
          .filter((id): id is string => Boolean(id)),
      ),
    ];
    if (userIds.length === 0) return;

    const { data: prefRows } = await db
      .from("notification_preferences")
      .select(
        "user_id, tasks_in_app, leads_in_app, opportunities_in_app, messages_in_app, system_in_app",
      )
      .in("user_id", userIds);

    const prefsByUser = new Map(
      (prefRows ?? []).map((row) => [row.user_id as string, mapPreferences(row)]),
    );

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

    const rows = userIds
      .filter((userId) => {
        const prefs = prefsByUser.get(userId) ?? DEFAULT_NOTIFICATION_PREFERENCES;
        return prefs.leadsInApp;
      })
      .map((userId) => ({
        user_id: userId,
        tenant_id: input.tenantId,
        category: "leads" as const,
        title: `New lead: ${displayName}`,
        body: channelLabel ? `Via ${channelLabel}` : null,
        href: `/leads/${input.contactId}`,
      }));

    if (rows.length === 0) return;

    const { error } = await db.from("user_notifications").insert(rows);
    if (error) {
      const missing = /user_notifications|schema cache|relation/i.test(error.message);
      if (!missing) {
        console.error("notifyTenantNewLead insert failed:", error.message);
      }
    }
  } catch (error) {
    console.error("notifyTenantNewLead failed:", error);
  }
}
