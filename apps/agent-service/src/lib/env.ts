import { z } from "zod";

const envSchema = z.object({
  OPENAI_API_KEY: z.string().optional(),
  OPENAI_MODEL: z.string().default("gpt-4o-mini"),
  TWILIO_ACCOUNT_SID: z.string().optional(),
  TWILIO_AUTH_TOKEN: z.string().optional(),
  TWILIO_PHONE_NUMBER: z.string().optional(),
  TWILIO_SKIP_SIGNATURE_VERIFY: z
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
  META_APP_ID: z.string().optional(),
  META_APP_SECRET: z.string().optional(),
  META_WEBHOOK_VERIFY_TOKEN: z.string().optional(),
  GOOGLE_CLIENT_ID: z.string().optional(),
  GOOGLE_CLIENT_SECRET: z.string().optional(),
  /** Google Places Autocomplete (New) / Maps Platform key. */
  GOOGLE_PLACES_API_KEY: z.string().optional(),
  /** Alias for GOOGLE_PLACES_API_KEY when using a shared Maps Platform key. */
  GOOGLE_MAPS_API_KEY: z.string().optional(),
  /** Jitsi Meet base URL (legacy fallback; video meetings use JaaS when configured). */
  JITSI_BASE_URL: z.string().url().optional(),
  /** 8x8 Jitsi as a Service — App ID (vpaas-magic-cookie-…). */
  JAAS_APP_ID: z.string().optional(),
  /** JaaS API key id (kid header when signing JWTs). */
  JAAS_API_KEY_ID: z.string().optional(),
  /** JaaS RSA private key PEM (use \n for newlines in env). */
  JAAS_PRIVATE_KEY: z.string().optional(),
  /** Optional HMAC secret for /api/meetings/join links. */
  MEETING_JOIN_SECRET: z.string().optional(),
  PLATFORM_SECRETS_ENCRYPTION_KEY: z.string().optional(),
  GHL_WEBHOOK_SECRET: z.string().optional(),
  CRON_SECRET: z.string().optional(),
});

export type Env = z.infer<typeof envSchema>;

export function getEnv(): Env {
  return envSchema.parse(process.env);
}

export function isOpenAIConfigured(env: Env = getEnv()): boolean {
  return Boolean(env.OPENAI_API_KEY);
}

export function isSupabaseConfigured(env: Env = getEnv()): boolean {
  return Boolean(
    env.NEXT_PUBLIC_SUPABASE_URL && env.SUPABASE_SERVICE_ROLE_KEY,
  );
}
