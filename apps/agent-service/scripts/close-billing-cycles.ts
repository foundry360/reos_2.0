/**
 * Manually close billing cycles for a calendar month (defaults to previous month).
 *
 * Usage (from apps/agent-service):
 *   npx tsx --env-file=.env.local scripts/close-billing-cycles.ts [YYYY-MM]
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  getPreviousBillingCycle,
  parseBillingCyclePeriod,
} from "../src/lib/admin/billing-cycle";
import { closeBillingCyclesForPeriod } from "../src/lib/admin/usage-billing";

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

function formatUsdFromCents(cents: number): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
  }).format(cents / 100);
}

async function main() {
  loadEnvIntoProcess(resolve(process.cwd(), ".env.local"));

  const periodArg = process.argv[2]?.trim();
  const cycle = periodArg
    ? parseBillingCyclePeriod(periodArg)
    : getPreviousBillingCycle();

  if (!cycle) {
    throw new Error("Invalid period. Use YYYY-MM (e.g. 2026-08).");
  }

  console.log(`=== Close billing cycles: ${cycle.label} ===\n`);

  const result = await closeBillingCyclesForPeriod(cycle);

  console.log(`Charged: ${result.charged.length}`);
  for (const row of result.charged) {
    console.log(
      `  ✓ ${row.tenantName}: ${formatUsdFromCents(row.subtotalCents)} → ${row.stripeInvoiceId}`,
    );
  }

  console.log(`\nSkipped: ${result.skipped.length}`);
  for (const row of result.skipped) {
    if (!row.tenantId) continue;
    console.log(`  - ${row.tenantName}: ${row.reason}`);
  }

  console.log(`\nFailed: ${result.failed.length}`);
  for (const row of result.failed) {
    console.log(`  ✗ ${row.tenantName || "system"}: ${row.error}`);
  }

  const total = result.charged.reduce((sum, row) => sum + row.subtotalCents, 0);
  console.log(`\nTotal collected: ${formatUsdFromCents(total)}`);

  if (result.failed.some((row) => row.tenantId)) {
    process.exit(1);
  }
}

main().catch((error) => {
  console.error("\n✗ Close billing cycles failed:", error instanceof Error ? error.message : error);
  process.exit(1);
});
