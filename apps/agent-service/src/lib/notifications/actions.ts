"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import type { NotificationPreferences } from "./types";

type ActionResult = { ok: true } | { ok: false; error: string };

async function requireUserId(): Promise<string | null> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  return user?.id ?? null;
}

export async function updateNotificationPreferencesAction(
  next: NotificationPreferences,
): Promise<ActionResult> {
  const userId = await requireUserId();
  if (!userId) return { ok: false, error: "Not signed in." };

  const supabase = await createClient();
  const { error } = await supabase.from("notification_preferences").upsert(
    {
      user_id: userId,
      tasks_in_app: next.tasksInApp,
      leads_in_app: next.leadsInApp,
      opportunities_in_app: next.opportunitiesInApp,
      messages_in_app: next.messagesInApp,
      system_in_app: next.systemInApp,
      updated_at: new Date().toISOString(),
    },
    { onConflict: "user_id" },
  );

  if (error) {
    const missing = /notification_preferences|schema cache|relation/i.test(error.message);
    if (missing) {
      return {
        ok: false,
        error: "Notification preferences are not set up yet. Run migration 031.",
      };
    }
    return { ok: false, error: error.message };
  }

  revalidatePath("/settings");
  revalidatePath("/admin/settings");
  revalidatePath("/", "layout");
  revalidatePath("/admin", "layout");
  return { ok: true };
}

export async function markNotificationReadAction(
  notificationId: string,
): Promise<ActionResult> {
  const userId = await requireUserId();
  if (!userId) return { ok: false, error: "Not signed in." };

  const supabase = await createClient();
  const { error } = await supabase
    .from("user_notifications")
    .update({ read_at: new Date().toISOString() })
    .eq("id", notificationId)
    .eq("user_id", userId)
    .is("read_at", null);

  if (error) {
    return { ok: false, error: error.message };
  }

  revalidatePath("/", "layout");
  revalidatePath("/admin", "layout");
  return { ok: true };
}

export async function markAllNotificationsReadAction(): Promise<ActionResult> {
  const userId = await requireUserId();
  if (!userId) return { ok: false, error: "Not signed in." };

  const supabase = await createClient();
  const { error } = await supabase
    .from("user_notifications")
    .update({ read_at: new Date().toISOString() })
    .eq("user_id", userId)
    .is("read_at", null);

  if (error) {
    return { ok: false, error: error.message };
  }

  revalidatePath("/", "layout");
  revalidatePath("/admin", "layout");
  return { ok: true };
}
