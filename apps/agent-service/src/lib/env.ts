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
  SF_INSTANCE_URL: z.string().url().optional(),
  SF_CLIENT_ID: z.string().optional(),
  SF_CLIENT_SECRET: z.string().optional(),
  SF_REFRESH_TOKEN: z.string().optional(),
  STRIPE_SECRET_KEY: z.string().optional(),
  STRIPE_WEBHOOK_SECRET: z.string().optional(),
});

export type Env = z.infer<typeof envSchema>;

export function getEnv(): Env {
  return envSchema.parse(process.env);
}

export function isOpenAIConfigured(env: Env = getEnv()): boolean {
  return Boolean(env.OPENAI_API_KEY);
}

export function isSalesforceConfigured(env: Env = getEnv()): boolean {
  return Boolean(
    env.SF_INSTANCE_URL &&
      env.SF_CLIENT_ID &&
      env.SF_CLIENT_SECRET &&
      env.SF_REFRESH_TOKEN,
  );
}
