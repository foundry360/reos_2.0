import { resolvePlatformSecret } from "@/lib/admin/platform-secrets";
import { getEnv } from "@/lib/env";

export async function getOpenAIApiKey(): Promise<string | undefined> {
  const value = await resolvePlatformSecret("openai_api_key");
  return value ?? undefined;
}

export async function isOpenAIConfiguredAsync(): Promise<boolean> {
  return Boolean(await getOpenAIApiKey());
}

export async function getTwilioCredentials(): Promise<{
  accountSid: string | undefined;
  authToken: string | undefined;
}> {
  const [accountSid, authToken] = await Promise.all([
    resolvePlatformSecret("twilio_account_sid"),
    resolvePlatformSecret("twilio_auth_token"),
  ]);

  return {
    accountSid: accountSid ?? undefined,
    authToken: authToken ?? undefined,
  };
}

export async function isTwilioConfiguredAsync(): Promise<boolean> {
  const { accountSid, authToken } = await getTwilioCredentials();
  return Boolean(accountSid && authToken);
}

export function getOpenAIModel(): string {
  return getEnv().OPENAI_MODEL;
}
