"use server";

import { revalidatePath } from "next/cache";
import { isValidTenantStatus } from "@/lib/admin/account-status";
import { startImpersonation, updateTenantStatus } from "@/lib/admin/actions";
import { requirePlatformAdmin } from "@/lib/admin/auth";
import { createClient } from "@/lib/supabase/server";
import type { ActionResult } from "@/lib/admin/tenant-config-actions";

export async function openTenantAction(formData: FormData): Promise<void> {
  const tenantId = String(formData.get("tenantId") ?? "");
  if (!tenantId) return;
  await startImpersonation(tenantId);
}

export async function activateTenantAction(formData: FormData): Promise<ActionResult> {
  const tenantId = String(formData.get("tenantId") ?? "").trim();
  if (!tenantId) return { ok: false, error: "Missing account id." };

  try {
    await updateTenantStatus(tenantId, "active");
    return { ok: true };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Could not activate account.";
    return { ok: false, error: message };
  }
}

export async function pauseTenantAction(formData: FormData): Promise<void> {
  const tenantId = String(formData.get("tenantId") ?? "");
  if (!tenantId) return;
  await updateTenantStatus(tenantId, "paused");
}

/** Set onboarding status from a chevron step click (keeps Details status in sync). */
export async function setTenantStatusFromStepAction(
  tenantId: string,
  status: string,
): Promise<ActionResult> {
  const id = tenantId.trim();
  if (!id) return { ok: false, error: "Missing account id." };
  if (!isValidTenantStatus(status) || status === "paused") {
    return { ok: false, error: "Invalid status." };
  }

  try {
    await updateTenantStatus(id, status);
    return { ok: true };
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Could not update status.";
    return { ok: false, error: message };
  }
}

export async function deleteTenantAction(tenantId: string): Promise<ActionResult> {
  await requirePlatformAdmin();

  const id = tenantId.trim();
  if (!id) return { ok: false, error: "Missing account id." };

  const supabase = await createClient();
  const { error } = await supabase.from("tenants").delete().eq("id", id);

  if (error) {
    return { ok: false, error: error.message };
  }

  revalidatePath("/admin");
  revalidatePath(`/admin/accounts/${id}`);
  return { ok: true };
}
