import { resolvePlatformSecret } from "@/lib/admin/platform-secrets";
import { getEnv } from "@/lib/env";

export async function getOpenAIApiKey(): Promise<string | undefined> {
  const value = await resolvePlatformSecret("openai_api_key");
  return value ?? undefined;
}

export async function isOpenAIConfiguredAsync(): Promise<boolean> {
  return Boolean(await getOpenAIApiKey());
}

export async function getTelnyxCredentials(): Promise<{
  apiKey: string | undefined;
  publicKey: string | undefined;
}> {
  const [apiKey, publicKey] = await Promise.all([
    resolvePlatformSecret("telnyx_api_key"),
    resolvePlatformSecret("telnyx_public_key"),
  ]);

  return {
    apiKey: apiKey ?? undefined,
    publicKey: publicKey ?? undefined,
  };
}

export async function isTelnyxConfiguredAsync(): Promise<boolean> {
  const { apiKey } = await getTelnyxCredentials();
  return Boolean(apiKey);
}

export function getOpenAIModel(): string {
  return getEnv().OPENAI_MODEL;
}
