/**
 * In-app notifications for tenant members, with an explicit outcome so callers
 * can tell "nobody to notify" apart from "couldn't notify".
 *
 * Pure module (relative imports only) so it runs under node --test.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import {
  DEFAULT_NOTIFICATION_PREFERENCES,
  NOTIFICATION_CATEGORY_META,
  type NotificationCategory,
  type NotificationPreferences,
} from "./types.ts";

export function prefEnabled(category: NotificationCategory, prefs: NotificationPreferences): boolean {
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

export interface NotifyMembersInput {
  tenantId: string;
  /** Limit to these users; they must still be members of the tenant. */
  userIds?: string[];
  category: NotificationCategory;
  title: string;
  body?: string | null;
  href?: string | null;
}

export type NotifyMembersResult =
  | { status: "notified"; count: number }
  /** "no_members": no matching tenant members. "preferences_off": every match turned this category off. */
  | { status: "no_recipients"; reason: "no_members" | "preferences_off" }
  | { status: "failed"; operation: "members" | "insert"; error: string };

/**
 * Notifies tenant members (all, or the given members) who have the category's
 * in-app preference on. Database errors are returned as "failed"; unexpected
 * exceptions propagate.
 */
export async function notifyMembers(db: SupabaseClient, input: NotifyMembersInput): Promise<NotifyMembersResult> {
  let query = db.from("memberships").select("user_id").eq("tenant_id", input.tenantId);
  if (input.userIds) query = query.in("user_id", input.userIds);
  const { data: members, error: membersError } = await query;
  if (membersError) return { status: "failed", operation: "members", error: membersError.message };

  const userIds = [
    ...new Set(
      ((members ?? []) as Array<{ user_id: string | null }>)
        .map((row) => row.user_id?.trim())
        .filter((id): id is string => Boolean(id)),
    ),
  ];
  if (userIds.length === 0) return { status: "no_recipients", reason: "no_members" };

  const { data: prefRows } = await db
    .from("notification_preferences")
    .select("user_id, tasks_in_app, leads_in_app, opportunities_in_app, messages_in_app, system_in_app")
    .in("user_id", userIds);

  const prefsByUser = new Map(
    ((prefRows ?? []) as Array<Parameters<typeof mapPreferences>[0] & { user_id: string }>).map((row) => [
      row.user_id,
      mapPreferences(row),
    ]),
  );

  const rows = userIds
    .filter((userId) => prefEnabled(input.category, prefsByUser.get(userId) ?? DEFAULT_NOTIFICATION_PREFERENCES))
    .map((userId) => ({
      user_id: userId,
      tenant_id: input.tenantId,
      category: input.category,
      title: input.title,
      body: input.body?.trim() || null,
      href: input.href?.trim() || null,
    }));
  if (rows.length === 0) return { status: "no_recipients", reason: "preferences_off" };

  const { error } = await db.from("user_notifications").insert(rows);
  if (error) return { status: "failed", operation: "insert", error: error.message };
  return { status: "notified", count: rows.length };
}
