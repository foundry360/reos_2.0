import { NextRequest, NextResponse } from "next/server";
import { getStripeClient, getStripeWebhookSecret } from "@/lib/admin/stripe";
import { markBillingCyclePaidFromStripeInvoice } from "@/lib/admin/usage-billing";

export async function POST(request: NextRequest) {
  const rawBody = await request.text();
  const signature = request.headers.get("stripe-signature");

  const webhookSecret = await getStripeWebhookSecret();
  if (!webhookSecret) {
    return NextResponse.json({ error: "Webhook signing secret not configured" }, { status: 501 });
  }

  if (!signature) {
    return NextResponse.json({ error: "Missing stripe-signature" }, { status: 400 });
  }

  const stripe = await getStripeClient();
  if (!stripe) {
    return NextResponse.json({ error: "Stripe secret key not configured" }, { status: 501 });
  }

  let event;
  try {
    event = stripe.webhooks.constructEvent(rawBody, signature, webhookSecret);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Invalid webhook signature";
    console.error("Stripe webhook verification failed:", message);
    return NextResponse.json({ error: message }, { status: 400 });
  }

  switch (event.type) {
    case "invoice.paid": {
      const invoice = event.data.object as {
        id: string;
        metadata?: { billing_cycle_id?: string; tenant_id?: string; purpose?: string };
        payment_intent?: string | { id?: string } | null;
      };
      if (invoice.metadata?.purpose === "usage_billing") {
        await markBillingCyclePaidFromStripeInvoice(invoice);
      }
      console.log("Stripe webhook received:", event.type, event.id);
      break;
    }
    case "invoice.payment_failed": {
      const invoice = event.data.object as {
        id: string;
        metadata?: { billing_cycle_id?: string; purpose?: string };
      };
      if (invoice.metadata?.purpose === "usage_billing" && invoice.metadata.billing_cycle_id) {
        console.log("Usage billing invoice payment failed:", invoice.id);
      }
      console.log("Stripe webhook received:", event.type, event.id);
      break;
    }
    case "payment_intent.succeeded":
    case "payment_intent.payment_failed":
      console.log("Stripe webhook received:", event.type, event.id);
      break;
    default:
      console.log("Stripe webhook received (unhandled):", event.type, event.id);
  }

  return NextResponse.json({ received: true });
}
