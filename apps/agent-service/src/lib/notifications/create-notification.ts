import { createClient } from "@/lib/supabase/server";
import {
  NOTIFICATION_CATEGORY_META,
  type NotificationCategory,
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
  prefs: Awaited<ReturnType<typeof getNotificationPreferences>>,
): boolean {
  const meta = NOTIFICATION_CATEGORY_META.find((item) => item.id === category);
  if (!meta) return false;
  return prefs[meta.prefKey];
}

/** Best-effort insert; never throws into calling CRM flows. */
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
