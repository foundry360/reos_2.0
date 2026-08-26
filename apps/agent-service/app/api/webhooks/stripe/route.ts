import { NextRequest, NextResponse } from "next/server";
import { getEnv } from "@/lib/env";

/**
 * Stripe Connect split webhook (optional).
 * Wire product/price IDs to setup vs standard split rules.
 * No Salesforce integration — payments are separate from CRM.
 */
export async function POST(request: NextRequest) {
  const env = getEnv();
  const rawBody = await request.text();
  const signature = request.headers.get("stripe-signature");

  if (!env.STRIPE_WEBHOOK_SECRET) {
    return NextResponse.json(
      { error: "STRIPE_WEBHOOK_SECRET not configured" },
      { status: 501 },
    );
  }

  if (!signature) {
    return NextResponse.json({ error: "Missing stripe-signature" }, { status: 400 });
  }

  // TODO: stripe.webhooks.constructEvent + transfer to Connect accounts
  console.log("Stripe webhook received (stub)", {
    length: rawBody.length,
    hasSignature: Boolean(signature),
  });

  return NextResponse.json({ received: true });
}
