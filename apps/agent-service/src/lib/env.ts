import { z } from "zod";

const envSchema = z.object({
  OPENAI_API_KEY: z.string().optional(),
  OPENAI_MODEL: z.string().default("gpt-4o-mini"),
  TELNYX_API_KEY: z.string().optional(),
  /** Base64 Ed25519 public key from Mission Control → Keys & Credentials → Public Key. */
  TELNYX_PUBLIC_KEY: z.string().optional(),
  /** Optional; only needed when the sending number is not tied to a messaging profile. */
  TELNYX_MESSAGING_PROFILE_ID: z.string().optional(),
  TELNYX_SKIP_SIGNATURE_VERIFY: z
    .string()
    .optional()
    .transform((v) => v === "true"),
  NEXT_PUBLIC_SUPABASE_URL: z.string().url().optional(),
  NEXT_PUBLIC_SUPABASE_ANON_KEY: z.string().optional(),
  SUPABASE_SERVICE_ROLE_KEY: z.string().optional(),
  STRIPE_SECRET_KEY: z.string().optional(),
  STRIPE_WEBHOOK_SECRET: z.string().optional(),
  RESEND_API_KEY: z.string().optional(),
  RESEND_FROM_EMAIL: z.string().email().optional(),
  RESEND_FROM_NAME: z.string().optional(),
  /** Resend webhook signing secret (whsec_…); the Resend webhook refuses every event without it. */
  RESEND_WEBHOOK_SECRET: z.string().optional(),
  META_APP_ID: z.string().optional(),
  META_APP_SECRET: z.string().optional(),
  META_WEBHOOK_VERIFY_TOKEN: z.string().optional(),
  /** Google Places Autocomplete (New) / Maps Platform key. */
  GOOGLE_PLACES_API_KEY: z.string().optional(),
  /** Alias for GOOGLE_PLACES_API_KEY when using a shared Maps Platform key. */
  GOOGLE_MAPS_API_KEY: z.string().optional(),
  /** Public Jitsi Meet base URL (default https://meet.jit.si). */
  JITSI_BASE_URL: z.string().url().optional(),
  /** Optional 8x8 JaaS App ID — only used for legacy signed join redirects. */
  JAAS_APP_ID: z.string().optional(),
  /** Optional JaaS API key id (kid). */
  JAAS_API_KEY_ID: z.string().optional(),
  /** Optional JaaS RSA private key PEM (use \n for newlines in env). */
  JAAS_PRIVATE_KEY: z.string().optional(),
  /** Optional HMAC secret for /api/meetings/join links. */
  MEETING_JOIN_SECRET: z.string().optional(),
  /** HMAC secret for email unsubscribe links. Required in production; development falls back (see unsubscribe-token.ts). */
  EMAIL_UNSUBSCRIBE_SECRET: z.string().optional(),
  PLATFORM_SECRETS_ENCRYPTION_KEY: z.string().optional(),
  GHL_WEBHOOK_SECRET: z.string().optional(),
  CRON_SECRET: z.string().optional(),
});

export type Env = z.infer<typeof envSchema>;

export function getEnv(): Env {
  return envSchema.parse(process.env);
}

/** A production build (next start / Vercel, previews included). Development-only bypasses are off here. */
export function isProductionRuntime(): boolean {
  return process.env.NODE_ENV === "production";
}

/**
 * Whether a webhook must verify its signature. Inbound messages change consent
 * (STOP / START), so production always verifies; elsewhere `skip` (an explicit
 * skip flag, or no secret configured) turns verification off for local work.
 */
export function mustVerifyWebhookSignature(skip: boolean): boolean {
  return isProductionRuntime() || !skip;
}

export function isOpenAIConfigured(env: Env = getEnv()): boolean {
  return Boolean(env.OPENAI_API_KEY);
}

export function isSupabaseConfigured(env: Env = getEnv()): boolean {
  return Boolean(
    env.NEXT_PUBLIC_SUPABASE_URL && env.SUPABASE_SERVICE_ROLE_KEY,
  );
}
