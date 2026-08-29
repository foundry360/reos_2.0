import { createClient } from "@/lib/supabase/server";
import {
  DEFAULT_NOTIFICATION_PREFERENCES,
  NOTIFICATION_CATEGORIES,
  NOTIFICATION_CATEGORY_META,
  type NotificationCategory,
  type NotificationPreferences,
  type UserNotification,
} from "./types";

export type {
  NotificationCategory,
  NotificationPreferences,
  UserNotification,
} from "./types";
export {
  DEFAULT_NOTIFICATION_PREFERENCES,
  NOTIFICATION_CATEGORIES,
  NOTIFICATION_CATEGORY_META,
} from "./types";

function isCategory(value: string): value is NotificationCategory {
  return (NOTIFICATION_CATEGORIES as readonly string[]).includes(value);
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

export async function getNotificationPreferences(
  userId: string,
): Promise<NotificationPreferences> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("notification_preferences")
    .select(
      "tasks_in_app, leads_in_app, opportunities_in_app, messages_in_app, system_in_app",
    )
    .eq("user_id", userId)
    .maybeSingle();

  if (error) {
    const missing = /notification_preferences|schema cache|relation/i.test(error.message);
    if (!missing) {
      console.error("notification preferences failed:", error.message);
    }
    return { ...DEFAULT_NOTIFICATION_PREFERENCES };
  }

  return mapPreferences(data);
}

export async function listUserNotifications(
  userId: string,
  options?: { limit?: number },
): Promise<UserNotification[]> {
  const limit = options?.limit ?? 30;
  const [prefs, supabase] = await Promise.all([
    getNotificationPreferences(userId),
    createClient(),
  ]);
  const enabled = new Set(
    NOTIFICATION_CATEGORY_META.filter((item) => prefs[item.prefKey]).map(
      (item) => item.id,
    ),
  );

  const { data, error } = await supabase
    .from("user_notifications")
    .select("id, category, title, body, href, read_at, created_at")
    .eq("user_id", userId)
    .order("created_at", { ascending: false })
    .limit(Math.max(limit * 2, 40));

  if (error) {
    const missing = /user_notifications|schema cache|relation/i.test(error.message);
    if (!missing) {
      console.error("user notifications failed:", error.message);
    }
    return [];
  }

  return (data ?? [])
    .flatMap((row) => {
      if (!isCategory(row.category) || !enabled.has(row.category)) return [];
      return [
        {
          id: row.id,
          category: row.category,
          title: row.title,
          body: row.body?.trim() || null,
          href: row.href?.trim() || null,
          readAt: row.read_at,
          createdAt: row.created_at,
        },
      ];
    })
    .slice(0, limit);
}

export async function countUnreadNotifications(userId: string): Promise<number> {
  const supabase = await createClient();
  const { count, error } = await supabase
    .from("user_notifications")
    .select("id", { count: "exact", head: true })
    .eq("user_id", userId)
    .is("read_at", null);

  if (error) {
    const missing = /user_notifications|schema cache|relation/i.test(error.message);
    if (!missing) {
      console.error("unread notifications count failed:", error.message);
    }
    return 0;
  }

  return count ?? 0;
}
