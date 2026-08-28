import {
  canEncryptPlatformSecrets,
  decryptPlatformSecret,
  encryptPlatformSecret,
  secretHint,
} from "@/lib/admin/platform-secrets-crypto";
import { getEnv } from "@/lib/env";
import { getSupabaseAdmin } from "@/lib/supabase/admin";

export const PLATFORM_SECRET_KEYS = [
  "openai_api_key",
  "twilio_account_sid",
  "twilio_auth_token",
  "stripe_secret_key",
  "stripe_webhook_secret",
  "resend_api_key",
] as const;

export type PlatformSecretKey = (typeof PLATFORM_SECRET_KEYS)[number];

export type IntegrationSource = "database" | "environment" | "none";

export interface PlatformSecretStatus {
  key: PlatformSecretKey;
  configured: boolean;
  source: IntegrationSource;
  hint: string | null;
  updatedAt: string | null;
}

export interface IntegrationsOverview {
  encryptionEnabled: boolean;
  openai: PlatformSecretStatus;
  twilio: {
    accountSid: PlatformSecretStatus;
    authToken: PlatformSecretStatus;
    configured: boolean;
    source: IntegrationSource;
  };
  stripe: {
    secretKey: PlatformSecretStatus;
    webhookSecret: PlatformSecretStatus;
    configured: boolean;
    source: IntegrationSource;
  };
  resend: PlatformSecretStatus;
}

interface SecretRow {
  key: string;
  ciphertext: string;
  iv: string;
  auth_tag: string;
  hint: string | null;
  updated_at: string;
}

const CACHE_TTL_MS = 60_000;
const secretCache = new Map<PlatformSecretKey, { value: string; expires: number }>();

function cacheGet(key: PlatformSecretKey): string | null {
  const hit = secretCache.get(key);
  if (!hit) return null;
  if (Date.now() > hit.expires) {
    secretCache.delete(key);
    return null;
  }
  return hit.value;
}

function cacheSet(key: PlatformSecretKey, value: string): void {
  secretCache.set(key, { value, expires: Date.now() + CACHE_TTL_MS });
}

export function clearPlatformSecretCache(): void {
  secretCache.clear();
}

async function readSecretRow(key: PlatformSecretKey): Promise<SecretRow | null> {
  const admin = getSupabaseAdmin();
  if (!admin) return null;

  const { data, error } = await admin
    .from("platform_secrets")
    .select("key, ciphertext, iv, auth_tag, hint, updated_at")
    .eq("key", key)
    .maybeSingle();

  if (error) {
    console.error(`platform_secrets read failed (${key}):`, error.message);
    return null;
  }

  return data as SecretRow | null;
}

export async function getPlatformSecret(key: PlatformSecretKey): Promise<string | null> {
  const cached = cacheGet(key);
  if (cached) return cached;

  const row = await readSecretRow(key);
  if (!row) return null;

  try {
    const value = decryptPlatformSecret({
      ciphertext: row.ciphertext,
      iv: row.iv,
      authTag: row.auth_tag,
    });
    cacheSet(key, value);
    return value;
  } catch (error) {
    console.error(`platform_secrets decrypt failed (${key}):`, error);
    return null;
  }
}

function envFallback(key: PlatformSecretKey): string | null {
  const env = getEnv();
  switch (key) {
    case "openai_api_key":
      return env.OPENAI_API_KEY?.trim() || null;
    case "twilio_account_sid":
      return env.TWILIO_ACCOUNT_SID?.trim() || null;
    case "twilio_auth_token":
      return env.TWILIO_AUTH_TOKEN?.trim() || null;
    case "stripe_secret_key":
      return env.STRIPE_SECRET_KEY?.trim() || null;
    case "stripe_webhook_secret":
      return env.STRIPE_WEBHOOK_SECRET?.trim() || null;
    case "resend_api_key":
      return env.RESEND_API_KEY?.trim() || null;
    default:
      return null;
  }
}

export async function resolvePlatformSecret(key: PlatformSecretKey): Promise<string | null> {
  const fromDb = await getPlatformSecret(key);
  if (fromDb) return fromDb;
  return envFallback(key);
}

async function buildSecretStatus(key: PlatformSecretKey): Promise<PlatformSecretStatus> {
  const row = await readSecretRow(key);
  if (row) {
    return {
      key,
      configured: true,
      source: "database",
      hint: row.hint,
      updatedAt: row.updated_at,
    };
  }

  const envValue = envFallback(key);
  return {
    key,
    configured: Boolean(envValue),
    source: envValue ? "environment" : "none",
    hint: envValue ? secretHint(envValue) : null,
    updatedAt: null,
  };
}


export async function fetchIntegrationsOverview(): Promise<IntegrationsOverview> {
  const [openai, accountSid, authToken, stripeSecretKey, stripeWebhookSecret, resend] =
    await Promise.all([
      buildSecretStatus("openai_api_key"),
      buildSecretStatus("twilio_account_sid"),
      buildSecretStatus("twilio_auth_token"),
      buildSecretStatus("stripe_secret_key"),
      buildSecretStatus("stripe_webhook_secret"),
      buildSecretStatus("resend_api_key"),
    ]);

  const twilioConfigured = accountSid.configured && authToken.configured;
  const twilioSource =
    accountSid.source === "database" || authToken.source === "database"
      ? "database"
      : twilioConfigured
        ? "environment"
        : "none";

  const stripeConfigured = stripeSecretKey.configured;
  const stripeSource =
    stripeSecretKey.source === "database" || stripeWebhookSecret.source === "database"
      ? "database"
      : stripeConfigured
        ? "environment"
        : "none";

  return {
    encryptionEnabled: canEncryptPlatformSecrets(),
    openai,
    twilio: {
      accountSid,
      authToken,
      configured: twilioConfigured,
      source: twilioSource,
    },
    stripe: {
      secretKey: stripeSecretKey,
      webhookSecret: stripeWebhookSecret,
      configured: stripeConfigured,
      source: stripeSource,
    },
    resend,
  };
}

export async function savePlatformSecret(
  key: PlatformSecretKey,
  value: string,
  updatedById: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const trimmed = value.trim();
  if (!trimmed) {
    return { ok: false, error: "Secret value is required." };
  }

  if (!canEncryptPlatformSecrets()) {
    return {
      ok: false,
      error:
        "Encrypted storage is not configured. Set PLATFORM_SECRETS_ENCRYPTION_KEY in the environment.",
    };
  }

  const admin = getSupabaseAdmin();
  if (!admin) {
    return { ok: false, error: "Database is not configured." };
  }

  let encrypted;
  try {
    encrypted = encryptPlatformSecret(trimmed);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Could not encrypt secret.";
    return { ok: false, error: message };
  }

  const { error } = await admin.from("platform_secrets").upsert({
    key,
    ciphertext: encrypted.ciphertext,
    iv: encrypted.iv,
    auth_tag: encrypted.authTag,
    hint: secretHint(trimmed),
    updated_at: new Date().toISOString(),
    updated_by_id: updatedById,
  });

  if (error) {
    console.error(`platform_secrets upsert failed (${key}):`, error.message);
    return { ok: false, error: "Could not save secret." };
  }

  clearPlatformSecretCache();
  return { ok: true };
}

export async function clearPlatformSecret(
  key: PlatformSecretKey,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const admin = getSupabaseAdmin();
  if (!admin) {
    return { ok: false, error: "Database is not configured." };
  }

  const { error } = await admin.from("platform_secrets").delete().eq("key", key);
  if (error) {
    console.error(`platform_secrets delete failed (${key}):`, error.message);
    return { ok: false, error: "Could not remove stored secret." };
  }

  clearPlatformSecretCache();
  return { ok: true };
}
