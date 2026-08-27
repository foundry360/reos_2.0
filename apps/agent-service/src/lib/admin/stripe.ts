import Stripe from "stripe";
import { resolvePlatformSecret } from "@/lib/admin/platform-secrets";
import { getEnv } from "@/lib/env";

let stripeClient: Stripe | null = null;
let stripeClientKey: string | null = null;

export async function getStripeSecretKey(): Promise<string | undefined> {
  const value = await resolvePlatformSecret("stripe_secret_key");
  return value ?? undefined;
}

export async function getStripeWebhookSecret(): Promise<string | undefined> {
  const value = await resolvePlatformSecret("stripe_webhook_secret");
  if (value) return value;
  return getEnv().STRIPE_WEBHOOK_SECRET?.trim() || undefined;
}

export async function isStripeConfiguredAsync(): Promise<boolean> {
  return Boolean(await getStripeSecretKey());
}

export async function getStripeClient(): Promise<Stripe | null> {
  const secretKey = await getStripeSecretKey();
  if (!secretKey) return null;

  if (stripeClient && stripeClientKey === secretKey) {
    return stripeClient;
  }

  stripeClient = new Stripe(secretKey);
  stripeClientKey = secretKey;
  return stripeClient;
}

export function getStripeWebhookUrl(origin: string): string {
  return `${origin.replace(/\/$/, "")}/api/webhooks/stripe`;
}

export async function verifyStripeConnection(): Promise<
  { ok: true; mode: "test" | "live" } | { ok: false; error: string }
> {
  const stripe = await getStripeClient();
  if (!stripe) {
    return { ok: false, error: "Stripe secret key is not configured." };
  }

  try {
    const balance = await stripe.balance.retrieve();
    const mode = balance.livemode ? "live" : "test";
    return { ok: true, mode };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Stripe connection failed.";
    return { ok: false, error: message };
  }
}
