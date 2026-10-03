"use server";

import { revalidatePath } from "next/cache";
import { getSupabaseAdmin } from "@/lib/supabase/admin";
import { TENANT_TIMEZONES } from "@/lib/admin/timezones";
import {
  normalizeWorkingHours,
  validateWorkingHours,
  type WorkingHours,
} from "@/lib/calendar/working-hours";
import { authorizeChannelManager, getWorkspaceAccess } from "@/lib/tenant/workspace-access";

export interface SaveCalendarSettingsResult {
  ok: boolean;
  error?: string;
}

function isValidTimeZone(value: string): boolean {
  if ((TENANT_TIMEZONES as readonly string[]).includes(value)) return true;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value });
    return value.includes("/");
  } catch {
    return false;
  }
}

export async function saveCalendarSettingsAction(input: {
  timeZone: string;
  workingHours: WorkingHours;
}): Promise<SaveCalendarSettingsResult> {
  const access = await getWorkspaceAccess();
  if (!access) return { ok: false, error: "Sign in to change calendar settings." };
  if (!(await authorizeChannelManager(access.tenantId))) {
    return { ok: false, error: "Only workspace owners can change calendar settings." };
  }

  if (!isValidTimeZone(input.timeZone)) {
    return { ok: false, error: "Pick a supported time zone." };
  }

  const problem = validateWorkingHours(input.workingHours);
  if (problem) return { ok: false, error: problem };
  const workingHours = normalizeWorkingHours(input.workingHours);

  const db = getSupabaseAdmin();
  if (!db) return { ok: false, error: "Database is not configured." };

  const { error } = await db
    .from("tenants")
    .update({ timezone: input.timeZone, working_hours: workingHours })
    .eq("id", access.tenantId);

  if (error) {
    console.error("save calendar settings failed:", error.message);
    return { ok: false, error: "Could not save calendar settings." };
  }

  revalidatePath("/calendar");
  return { ok: true };
}
