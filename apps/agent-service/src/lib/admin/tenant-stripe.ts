import { getStripeClient, isStripeConfiguredAsync } from "@/lib/admin/stripe";
import { createClient } from "@/lib/supabase/server";

export interface TenantStripeProfile {
  id: string;
  name: string;
  slug: string;
  email: string | null;
  stripeCustomerId: string | null;
}

export interface StripeCustomerLinkProfile {
  customerId: string;
  name: string | null;
  email: string | null;
  hasPaymentMethod: boolean;
}

export async function loadTenantStripeProfile(
  tenantId: string,
): Promise<TenantStripeProfile | null> {
  const supabase = await createClient();
  const { data } = await supabase
    .from("tenants")
    .select("id, name, slug, email, stripe_customer_id")
    .eq("id", tenantId)
    .maybeSingle();

  if (!data) return null;

  return {
    id: data.id,
    name: data.name,
    slug: data.slug,
    email: data.email,
    stripeCustomerId: data.stripe_customer_id,
  };
}

export async function verifyStripeCustomerForLinking(
  customerId: string,
): Promise<{ ok: true; profile: StripeCustomerLinkProfile } | { ok: false; error: string }> {
  const normalized = customerId.trim();
  if (!normalized) {
    return { ok: false, error: "Stripe customer ID is required." };
  }

  if (!(await isStripeConfiguredAsync())) {
    return { ok: false, error: "Stripe is not configured. Add platform keys under Integrations." };
  }

  const stripe = await getStripeClient();
  if (!stripe) {
    return { ok: false, error: "Stripe is not configured. Add platform keys under Integrations." };
  }

  try {
    const customer = await stripe.customers.retrieve(normalized);
    if (customer.deleted) {
      return { ok: false, error: "That Stripe customer was deleted." };
    }

    const hasDefaultPaymentMethod = Boolean(customer.invoice_settings?.default_payment_method);
    let hasPaymentMethod = hasDefaultPaymentMethod;

    if (!hasPaymentMethod) {
      const paymentMethods = await stripe.paymentMethods.list({
        customer: normalized,
        type: "card",
        limit: 1,
      });
      hasPaymentMethod = paymentMethods.data.length > 0;
    }

    if (!hasPaymentMethod) {
      return {
        ok: false,
        error:
          "This Stripe customer has no payment method on file. Complete setup payment in GHL first.",
      };
    }

    return {
      ok: true,
      profile: {
        customerId: customer.id,
        name: customer.name ?? null,
        email: customer.email ?? null,
        hasPaymentMethod: true,
      },
    };
  } catch {
    return {
      ok: false,
      error: "Stripe customer not found. Check the customer ID from GHL or Stripe.",
    };
  }
}

export async function tenantStripeUsageReady(customerId: string): Promise<boolean> {
  const result = await verifyStripeCustomerForLinking(customerId);
  return result.ok;
}
