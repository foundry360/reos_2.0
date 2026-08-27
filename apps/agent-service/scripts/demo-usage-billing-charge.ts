/**
 * End-to-end demo: record usage → invoice → charge linked Stripe customer.
 *
 * Usage (from apps/agent-service):
 *   npx tsx --env-file=.env.local scripts/demo-usage-billing-charge.ts [tenantId] [--force]
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { chargeTenantUsageCycle, recordUsageEvent } from "../src/lib/admin/usage-billing";

const DEFAULT_TENANT_ID = "1d418920-04d8-40d8-ba62-e8cf382c6c84";

function formatUsdFromCents(cents: number): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
  }).format(cents / 100);
}

function loadEnvIntoProcess(path: string): void {
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const idx = trimmed.indexOf("=");
    if (idx === -1) continue;
    const key = trimmed.slice(0, idx);
    const value = trimmed.slice(idx + 1);
    if (!process.env[key]) {
      process.env[key] = value;
    }
  }
}

async function main() {
  const args = process.argv.slice(2);
  const force = args.includes("--force");
  const tenantId = args.find((arg) => !arg.startsWith("--"))?.trim() || DEFAULT_TENANT_ID;

  loadEnvIntoProcess(resolve(process.cwd(), ".env.local"));

  console.log("=== REOS usage billing charge demo ===\n");
  console.log(`Tenant: ${tenantId}`);
  console.log(`Force re-charge: ${force ? "yes" : "no"}\n`);

  const demoKey = Date.now().toString(36);

  const usageRows = [
    {
      category: "twilio_sms" as const,
      quantity: 420,
      unit: "messages",
      billableAmountCents: 1250,
      referenceId: `demo-sms-${demoKey}`,
      metadata: { demo: true, note: "Outbound SMS usage" },
    },
    {
      category: "ai_tokens" as const,
      quantity: 185000,
      unit: "tokens",
      billableAmountCents: 875,
      referenceId: `demo-ai-${demoKey}`,
      metadata: { demo: true, note: "Concierge + intake model usage" },
    },
    {
      category: "twilio_number" as const,
      quantity: 1,
      unit: "number",
      billableAmountCents: 200,
      referenceId: `demo-number-${demoKey}`,
      metadata: { demo: true, note: "Primary phone number monthly fee" },
    },
  ];

  console.log("Recording demo usage events…");
  for (const row of usageRows) {
    const result = await recordUsageEvent({
      tenantId,
      category: row.category,
      quantity: row.quantity,
      unit: row.unit,
      billableAmountCents: row.billableAmountCents,
      referenceId: row.referenceId,
      metadata: row.metadata,
    });

    if (!result.ok) {
      throw new Error(`Failed to record ${row.category}: ${result.error}`);
    }

    console.log(
      `  + ${row.category}: ${formatUsdFromCents(row.billableAmountCents)} (${row.quantity} ${row.unit})`,
    );
  }

  const demoTotalCents = usageRows.reduce((sum, row) => sum + row.billableAmountCents, 0);
  console.log(`\nDemo usage total: ${formatUsdFromCents(demoTotalCents)}`);

  console.log("\nCreating Stripe invoice and charging customer…");
  const charge = await chargeTenantUsageCycle(tenantId, { force });

  if (!charge.ok) {
    throw new Error(charge.error);
  }

  console.log("\n✓ Usage billing charge completed.\n");
  console.log(`Account: ${charge.tenantName}`);
  console.log(`Billing cycle: ${charge.cycle.label}`);
  console.log(`Subtotal: ${formatUsdFromCents(charge.subtotalCents)}`);
  console.log(`Invoice: ${charge.stripeInvoiceId} (${charge.invoiceStatus})`);
  if (charge.stripePaymentIntentId) {
    console.log(`Payment intent: ${charge.stripePaymentIntentId}`);
  }

  console.log("\nLine items:");
  for (const item of charge.categoryCharges) {
    console.log(`  - ${item.label}: ${formatUsdFromCents(item.amountCents)}`);
  }

  console.log("\nStripe Dashboard:");
  console.log(`  ${charge.stripeDashboardUrl}`);

  console.log("\nREOS Admin:");
  console.log(`  http://localhost:3000/admin/billing/tenants/${tenantId}`);
  console.log(`  http://localhost:3000/admin/accounts/${tenantId}`);
}

main().catch((error) => {
  console.error("\n✗ Demo failed:", error instanceof Error ? error.message : error);
  process.exit(1);
});
