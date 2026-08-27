/**
 * End-to-end test for linking an existing Stripe customer for usage billing.
 *
 * Usage (from apps/agent-service):
 *   npx tsx --env-file=.env.local scripts/test-stripe-usage-link.ts [tenantId]
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import Stripe from "stripe";
import { createClient } from "@supabase/supabase-js";
import { createDecipheriv } from "node:crypto";

const DEFAULT_TENANT_ID = "1d418920-04d8-40d8-ba62-e8cf382c6c84";

function loadEnvFile(path: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const idx = trimmed.indexOf("=");
    if (idx === -1) continue;
    out[trimmed.slice(0, idx)] = trimmed.slice(idx + 1);
  }
  return out;
}

function decryptPlatformSecret(payload: {
  ciphertext: string;
  iv: string;
  authTag: string;
  keyHex: string;
}): string {
  const key = Buffer.from(payload.keyHex, "hex");
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(payload.iv, "base64"));
  decipher.setAuthTag(Buffer.from(payload.authTag, "base64"));
  return Buffer.concat([
    decipher.update(Buffer.from(payload.ciphertext, "base64")),
    decipher.final(),
  ]).toString("utf8");
}

async function resolveStripeSecret(env: Record<string, string>): Promise<string> {
  const fromEnv = env.STRIPE_SECRET_KEY?.trim();
  if (fromEnv) return fromEnv;

  const supabase = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY);
  const { data, error } = await supabase
    .from("platform_secrets")
    .select("ciphertext, iv, auth_tag")
    .eq("key", "stripe_secret_key")
    .maybeSingle();

  if (error || !data) {
    throw new Error("Stripe secret key not found in env or platform_secrets.");
  }

  return decryptPlatformSecret({
    ciphertext: data.ciphertext,
    iv: data.iv,
    authTag: data.auth_tag,
    keyHex: env.PLATFORM_SECRETS_ENCRYPTION_KEY,
  });
}

async function verifyCustomer(stripe: Stripe, customerId: string) {
  const customer = await stripe.customers.retrieve(customerId);
  if (customer.deleted) throw new Error("Customer was deleted.");

  const hasDefault = Boolean(customer.invoice_settings?.default_payment_method);
  const paymentMethods = await stripe.paymentMethods.list({
    customer: customerId,
    type: "card",
    limit: 1,
  });

  return {
    customerId: customer.id,
    name: customer.name,
    email: customer.email,
    hasPaymentMethod: hasDefault || paymentMethods.data.length > 0,
  };
}

async function main() {
  const tenantId = process.argv[2]?.trim() || DEFAULT_TENANT_ID;
  const envPath = resolve(process.cwd(), ".env.local");
  const env = loadEnvFile(envPath);

  console.log("=== REOS Stripe usage link test ===\n");

  const secretKey = await resolveStripeSecret(env);
  const stripe = new Stripe(secretKey);

  const balance = await stripe.balance.retrieve();
  console.log(`Stripe mode: ${balance.livemode ? "LIVE" : "TEST"}`);

  const customer = await stripe.customers.create({
    name: "REOS Usage Billing Test",
    email: "usage-billing-test@reos.local",
    metadata: { reos_test: "usage_billing_link" },
  });
  console.log(`Created test customer: ${customer.id}`);

  const attached = await stripe.paymentMethods.attach("pm_card_visa", {
    customer: customer.id,
  });
  await stripe.customers.update(customer.id, {
    invoice_settings: { default_payment_method: attached.id },
  });
  console.log(`Attached test card: ${attached.id}`);

  const verified = await verifyCustomer(stripe, customer.id);
  console.log("Verification:", verified);

  if (!verified.hasPaymentMethod) {
    throw new Error("Test customer has no payment method — link flow would fail.");
  }

  const supabase = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY);
  const { data: tenantBefore } = await supabase
    .from("tenants")
    .select("id, name, stripe_customer_id")
    .eq("id", tenantId)
    .maybeSingle();

  if (!tenantBefore) {
    throw new Error(`Tenant not found: ${tenantId}`);
  }

  console.log(`\nTenant: ${tenantBefore.name} (${tenantBefore.id})`);
  console.log(`Previous stripe_customer_id: ${tenantBefore.stripe_customer_id ?? "(none)"}`);

  const { error: updateError } = await supabase
    .from("tenants")
    .update({ stripe_customer_id: customer.id })
    .eq("id", tenantId);

  if (updateError) {
    throw new Error(`Failed to link tenant: ${updateError.message}`);
  }

  const { data: tenantAfter } = await supabase
    .from("tenants")
    .select("stripe_customer_id")
    .eq("id", tenantId)
    .single();

  console.log(`Linked stripe_customer_id: ${tenantAfter?.stripe_customer_id ?? "(unknown)"}`);
  console.log("\n✓ Link test passed.");
  console.log(`\nOpen in admin:`);
  console.log(`  http://localhost:3000/admin/accounts/${tenantId}`);
  console.log(`  https://reos-sf.vercel.app/admin/accounts/${tenantId}`);
  console.log(`\nUse this customer ID in the Connect modal: ${customer.id}`);
}

main().catch((error) => {
  console.error("\n✗ Test failed:", error instanceof Error ? error.message : error);
  process.exit(1);
});
