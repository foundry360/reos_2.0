"use server";

import { revalidatePath } from "next/cache";
import { requirePlatformAdmin } from "@/lib/admin/auth";
import {
  clearPlatformSecret,
  savePlatformSecret,
  type PlatformSecretKey,
} from "@/lib/admin/platform-secrets";
import type { ActionResult } from "@/lib/admin/tenant-config-actions";

function revalidateIntegrations() {
  revalidatePath("/admin/integrations");
}

export async function saveOpenAIKeyAction(formData: FormData): Promise<ActionResult> {
  const admin = await requirePlatformAdmin();
  const apiKey = String(formData.get("apiKey") ?? "");

  const result = await savePlatformSecret("openai_api_key", apiKey, admin.id);
  if (!result.ok) return result;

  revalidateIntegrations();
  return { ok: true };
}

export async function saveTwilioCredentialsAction(formData: FormData): Promise<ActionResult> {
  const admin = await requirePlatformAdmin();
  const accountSid = String(formData.get("accountSid") ?? "");
  const authToken = String(formData.get("authToken") ?? "");

  const sidResult = await savePlatformSecret("twilio_account_sid", accountSid, admin.id);
  if (!sidResult.ok) return sidResult;

  const tokenResult = await savePlatformSecret("twilio_auth_token", authToken, admin.id);
  if (!tokenResult.ok) return tokenResult;

  revalidateIntegrations();
  return { ok: true };
}

export async function clearStoredSecretAction(key: PlatformSecretKey): Promise<ActionResult> {
  await requirePlatformAdmin();

  const result = await clearPlatformSecret(key);
  if (!result.ok) return result;

  revalidateIntegrations();
  return { ok: true };
}

export async function clearOpenAIStoredKeyAction(): Promise<ActionResult> {
  return clearStoredSecretAction("openai_api_key");
}

export async function clearTwilioStoredSecretsAction(): Promise<ActionResult> {
  const tokenResult = await clearStoredSecretAction("twilio_auth_token");
  if (!tokenResult.ok) return tokenResult;
  return clearStoredSecretAction("twilio_account_sid");
}

export async function saveStripeCredentialsAction(formData: FormData): Promise<ActionResult> {
  const admin = await requirePlatformAdmin();
  const secretKey = String(formData.get("secretKey") ?? "").trim();
  const webhookSecret = String(formData.get("webhookSecret") ?? "").trim();

  if (!secretKey && !webhookSecret) {
    return { ok: false, error: "Enter a secret key and/or webhook signing secret." };
  }

  if (secretKey) {
    const keyResult = await savePlatformSecret("stripe_secret_key", secretKey, admin.id);
    if (!keyResult.ok) return keyResult;
  }

  if (webhookSecret) {
    const webhookResult = await savePlatformSecret(
      "stripe_webhook_secret",
      webhookSecret,
      admin.id,
    );
    if (!webhookResult.ok) return webhookResult;
  }

  revalidateIntegrations();
  return { ok: true };
}

export async function clearStripeStoredSecretsAction(): Promise<ActionResult> {
  const webhookResult = await clearStoredSecretAction("stripe_webhook_secret");
  if (!webhookResult.ok) return webhookResult;
  return clearStoredSecretAction("stripe_secret_key");
}

export async function testStripeConnectionAction(): Promise<
  ActionResult & { mode?: "test" | "live" }
> {
  await requirePlatformAdmin();

  const { verifyStripeConnection } = await import("@/lib/admin/stripe");
  const result = await verifyStripeConnection();
  if (!result.ok) return { ok: false, error: result.error };

  return { ok: true, mode: result.mode };
}
