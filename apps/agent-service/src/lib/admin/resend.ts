import { resolvePlatformSecret } from "@/lib/admin/platform-secrets";

export async function getResendApiKey(): Promise<string | null> {
  return resolvePlatformSecret("resend_api_key");
}

export async function isResendConfigured(): Promise<boolean> {
  return Boolean(await getResendApiKey());
}
