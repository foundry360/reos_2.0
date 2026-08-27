import {
  USAGE_CATEGORY_LABELS,
  type UsageCategory,
} from "@/lib/admin/billing-categories";
import { getCurrentBillingCycle, type BillingCycleWindow } from "@/lib/admin/billing-cycle";
import { getStripeClient } from "@/lib/admin/stripe";
import { verifyStripeCustomerForLinking } from "@/lib/admin/tenant-stripe";
import { getSupabaseAdmin } from "@/lib/supabase/admin";

export interface UsageCategoryCharge {
  category: UsageCategory;
  label: string;
  amountCents: number;
}

export interface ChargeTenantUsageResult {
  ok: true;
  tenantId: string;
  tenantName: string;
  billingCycleId: string;
  cycle: BillingCycleWindow;
  subtotalCents: number;
  categoryCharges: UsageCategoryCharge[];
  stripeInvoiceId: string;
  stripePaymentIntentId: string | null;
  invoiceStatus: string;
  stripeDashboardUrl: string;
}

export interface ChargeTenantUsageError {
  ok: false;
  error: string;
}

export type ChargeTenantUsageResponse = ChargeTenantUsageResult | ChargeTenantUsageError;

function periodDates(cycle: BillingCycleWindow): { periodStart: string; periodEnd: string } {
  return {
    periodStart: cycle.start.slice(0, 10),
    periodEnd: cycle.end.slice(0, 10),
  };
}

async function aggregateUsageByCategory(
  tenantId: string,
  cycle: BillingCycleWindow,
): Promise<UsageCategoryCharge[]> {
  const admin = getSupabaseAdmin();
  if (!admin) return [];

  const { data, error } = await admin
    .from("usage_events")
    .select("category, billable_amount_cents")
    .eq("tenant_id", tenantId)
    .gte("occurred_at", cycle.start)
    .lte("occurred_at", cycle.end);

  if (error) {
    console.error("usage_events aggregate failed:", error.message);
    return [];
  }

  const totals = new Map<UsageCategory, number>();
  for (const row of data ?? []) {
    const category = row.category as UsageCategory;
    totals.set(category, (totals.get(category) ?? 0) + Number(row.billable_amount_cents ?? 0));
  }

  return [...totals.entries()]
    .filter(([, amountCents]) => amountCents > 0)
    .map(([category, amountCents]) => ({
      category,
      label: USAGE_CATEGORY_LABELS[category],
      amountCents,
    }));
}

function stripeDashboardInvoiceUrl(invoiceId: string, livemode: boolean): string {
  const prefix = livemode ? "https://dashboard.stripe.com" : "https://dashboard.stripe.com/test";
  return `${prefix}/invoices/${invoiceId}`;
}

function readPaymentIntentId(invoice: { payment_intent?: unknown }): string | null {
  const paymentIntent = invoice.payment_intent;
  if (typeof paymentIntent === "string") return paymentIntent;
  if (paymentIntent && typeof paymentIntent === "object" && "id" in paymentIntent) {
    const id = (paymentIntent as { id?: unknown }).id;
    return typeof id === "string" ? id : null;
  }
  return null;
}

export async function chargeTenantUsageCycle(
  tenantId: string,
  options?: { cycle?: BillingCycleWindow; force?: boolean },
): Promise<ChargeTenantUsageResponse> {
  const admin = getSupabaseAdmin();
  if (!admin) {
    return { ok: false, error: "Database is not configured." };
  }

  const stripe = await getStripeClient();
  if (!stripe) {
    return { ok: false, error: "Stripe is not configured. Add platform keys under Integrations." };
  }

  const { data: tenant, error: tenantError } = await admin
    .from("tenants")
    .select("id, name, stripe_customer_id")
    .eq("id", tenantId)
    .maybeSingle();

  if (tenantError || !tenant) {
    return { ok: false, error: "Account not found." };
  }

  if (!tenant.stripe_customer_id) {
    return { ok: false, error: "Stripe customer is not linked for this account." };
  }

  const verification = await verifyStripeCustomerForLinking(tenant.stripe_customer_id);
  if (!verification.ok) {
    return { ok: false, error: verification.error };
  }

  const cycle = options?.cycle ?? getCurrentBillingCycle();
  const { periodStart, periodEnd } = periodDates(cycle);

  const { data: existingCycle } = await admin
    .from("billing_cycles")
    .select("id, status, stripe_invoice_id")
    .eq("tenant_id", tenantId)
    .eq("period_start", periodStart)
    .maybeSingle();

  if (existingCycle && (existingCycle.status === "paid" || existingCycle.status === "invoiced")) {
    if (!options?.force) {
      return {
        ok: false,
        error: `Usage for ${cycle.label} was already invoiced (${existingCycle.stripe_invoice_id ?? existingCycle.id}).`,
      };
    }

    await admin.from("billing_cycles").delete().eq("id", existingCycle.id);
  }

  const categoryCharges = await aggregateUsageByCategory(tenantId, cycle);
  const subtotalCents = categoryCharges.reduce((sum, row) => sum + row.amountCents, 0);

  if (subtotalCents <= 0) {
    return { ok: false, error: "No billable usage found for this billing cycle." };
  }

  const { data: billingCycle, error: cycleError } = await admin
    .from("billing_cycles")
    .upsert(
      {
        tenant_id: tenantId,
        period_start: periodStart,
        period_end: periodEnd,
        status: "closing",
        subtotal_cents: subtotalCents,
        closed_at: new Date().toISOString(),
      },
      { onConflict: "tenant_id,period_start" },
    )
    .select("id")
    .single();

  if (cycleError || !billingCycle) {
    return { ok: false, error: cycleError?.message ?? "Could not create billing cycle." };
  }

  try {
    for (const charge of categoryCharges) {
      await stripe.invoiceItems.create({
        customer: tenant.stripe_customer_id,
        amount: charge.amountCents,
        currency: "usd",
        description: `${charge.label} — ${cycle.label}`,
        metadata: {
          tenant_id: tenantId,
          billing_cycle_id: billingCycle.id,
          usage_category: charge.category,
          purpose: "usage_billing",
        },
      });
    }

    const invoice = await stripe.invoices.create({
      customer: tenant.stripe_customer_id,
      collection_method: "charge_automatically",
      auto_advance: false,
      pending_invoice_items_behavior: "include",
      metadata: {
        tenant_id: tenantId,
        billing_cycle_id: billingCycle.id,
        purpose: "usage_billing",
      },
    });

    const finalized = await stripe.invoices.finalizeInvoice(invoice.id);
    const paid =
      finalized.status === "paid"
        ? finalized
        : await stripe.invoices.pay(finalized.id);

    const paidInvoice = await stripe.invoices.retrieve(paid.id, {
      expand: ["payment_intent"],
    });
    const paymentIntentId = readPaymentIntentId(paidInvoice as unknown as { payment_intent?: unknown });

    const status = paid.status === "paid" ? "paid" : paid.status === "open" ? "invoiced" : "failed";

    await admin
      .from("billing_cycles")
      .update({
        status,
        subtotal_cents: subtotalCents,
        stripe_invoice_id: paid.id,
        stripe_payment_intent_id: paymentIntentId,
        paid_at: status === "paid" ? new Date().toISOString() : null,
      })
      .eq("id", billingCycle.id);

    return {
      ok: true,
      tenantId: tenant.id,
      tenantName: tenant.name,
      billingCycleId: billingCycle.id,
      cycle,
      subtotalCents,
      categoryCharges,
      stripeInvoiceId: paid.id,
      stripePaymentIntentId: paymentIntentId,
      invoiceStatus: paid.status ?? status,
      stripeDashboardUrl: stripeDashboardInvoiceUrl(paid.id, paid.livemode),
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Stripe invoice failed.";

    await admin
      .from("billing_cycles")
      .update({ status: "failed" })
      .eq("id", billingCycle.id);

    return { ok: false, error: message };
  }
}

export async function recordUsageEvent(input: {
  tenantId: string;
  category: UsageCategory;
  quantity: number;
  unit: string;
  billableAmountCents: number;
  referenceId?: string;
  metadata?: Record<string, unknown>;
  occurredAt?: string;
}): Promise<{ ok: true; id: string } | { ok: false; error: string }> {
  const admin = getSupabaseAdmin();
  if (!admin) {
    return { ok: false, error: "Database is not configured." };
  }

  const { data, error } = await admin
    .from("usage_events")
    .insert({
      tenant_id: input.tenantId,
      category: input.category,
      quantity: input.quantity,
      unit: input.unit,
      billable_amount_cents: input.billableAmountCents,
      reference_id: input.referenceId ?? null,
      metadata: input.metadata ?? {},
      occurred_at: input.occurredAt ?? new Date().toISOString(),
    })
    .select("id")
    .single();

  if (error || !data) {
    return { ok: false, error: error?.message ?? "Could not record usage event." };
  }

  return { ok: true, id: data.id };
}

export async function markBillingCyclePaidFromStripeInvoice(invoice: {
  id: string;
  metadata?: { billing_cycle_id?: string; tenant_id?: string };
  payment_intent?: string | { id?: string } | null;
}): Promise<void> {
  const billingCycleId = invoice.metadata?.billing_cycle_id?.trim();
  if (!billingCycleId) return;

  const admin = getSupabaseAdmin();
  if (!admin) return;

  const paymentIntentId =
    typeof invoice.payment_intent === "string"
      ? invoice.payment_intent
      : invoice.payment_intent?.id ?? null;

  await admin
    .from("billing_cycles")
    .update({
      status: "paid",
      stripe_invoice_id: invoice.id,
      stripe_payment_intent_id: paymentIntentId,
      paid_at: new Date().toISOString(),
    })
    .eq("id", billingCycleId);
}

export interface CloseBillingCyclesSkipped {
  tenantId: string;
  tenantName: string;
  reason: string;
}

export interface CloseBillingCyclesFailed {
  tenantId: string;
  tenantName: string;
  error: string;
}

export interface CloseBillingCyclesResult {
  cycle: BillingCycleWindow;
  charged: ChargeTenantUsageResult[];
  skipped: CloseBillingCyclesSkipped[];
  failed: CloseBillingCyclesFailed[];
}

function isSkipReason(error: string): boolean {
  return (
    error.includes("No billable usage") ||
    error.includes("already invoiced") ||
    error.includes("Stripe customer is not linked")
  );
}

export async function closeBillingCyclesForPeriod(
  cycle: BillingCycleWindow,
): Promise<CloseBillingCyclesResult> {
  const admin = getSupabaseAdmin();
  if (!admin) {
    return { cycle, charged: [], skipped: [], failed: [{ tenantId: "", tenantName: "", error: "Database is not configured." }] };
  }

  const { data: tenants, error } = await admin
    .from("tenants")
    .select("id, name, stripe_customer_id")
    .order("name", { ascending: true });

  if (error) {
    return {
      cycle,
      charged: [],
      skipped: [],
      failed: [{ tenantId: "", tenantName: "", error: error.message }],
    };
  }

  const charged: ChargeTenantUsageResult[] = [];
  const skipped: CloseBillingCyclesSkipped[] = [];
  const failed: CloseBillingCyclesFailed[] = [];

  for (const tenant of tenants ?? []) {
    if (!tenant.stripe_customer_id) {
      skipped.push({
        tenantId: tenant.id,
        tenantName: tenant.name,
        reason: "Stripe customer is not linked.",
      });
      continue;
    }

    const result = await chargeTenantUsageCycle(tenant.id, { cycle });

    if (result.ok) {
      charged.push(result);
      continue;
    }

    if (isSkipReason(result.error)) {
      skipped.push({
        tenantId: tenant.id,
        tenantName: tenant.name,
        reason: result.error,
      });
      continue;
    }

    failed.push({
      tenantId: tenant.id,
      tenantName: tenant.name,
      error: result.error,
    });
  }

  return { cycle, charged, skipped, failed };
}
