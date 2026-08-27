import { NextRequest, NextResponse } from "next/server";
import {
  getPreviousBillingCycle,
  parseBillingCyclePeriod,
} from "@/lib/admin/billing-cycle";
import { closeBillingCyclesForPeriod } from "@/lib/admin/usage-billing";
import { getEnv } from "@/lib/env";

export const maxDuration = 300;

function readCronSecret(request: NextRequest): string | null {
  const authorization = request.headers.get("authorization");
  if (authorization?.toLowerCase().startsWith("bearer ")) {
    return authorization.slice(7).trim();
  }

  return request.headers.get("x-cron-secret")?.trim() ?? null;
}

function unauthorized() {
  return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
}

function resolveCycle(request: NextRequest) {
  const period = request.nextUrl.searchParams.get("period")?.trim();
  if (period) {
    const parsed = parseBillingCyclePeriod(period);
    if (!parsed) {
      return { error: "Invalid period. Use YYYY-MM (e.g. 2026-08)." as const };
    }
    return { cycle: parsed };
  }

  return { cycle: getPreviousBillingCycle() };
}

async function handleCloseBillingCycles(request: NextRequest) {
  const configuredSecret = getEnv().CRON_SECRET?.trim();
  if (!configuredSecret) {
    return NextResponse.json({ error: "CRON_SECRET is not configured." }, { status: 501 });
  }

  const providedSecret = readCronSecret(request);
  if (!providedSecret || providedSecret !== configuredSecret) {
    return unauthorized();
  }

  const resolved = resolveCycle(request);
  if ("error" in resolved) {
    return NextResponse.json({ error: resolved.error }, { status: 400 });
  }

  const result = await closeBillingCyclesForPeriod(resolved.cycle);

  console.log(
    "Closed billing cycles:",
    resolved.cycle.label,
    `${result.charged.length} charged`,
    `${result.skipped.length} skipped`,
    `${result.failed.length} failed`,
  );

  return NextResponse.json({
    ok: true,
    cycle: result.cycle,
    summary: {
      charged: result.charged.length,
      skipped: result.skipped.length,
      failed: result.failed.length,
      totalCollectedCents: result.charged.reduce((sum, row) => sum + row.subtotalCents, 0),
    },
    charged: result.charged.map((row) => ({
      tenantId: row.tenantId,
      tenantName: row.tenantName,
      subtotalCents: row.subtotalCents,
      stripeInvoiceId: row.stripeInvoiceId,
      invoiceStatus: row.invoiceStatus,
    })),
    skipped: result.skipped,
    failed: result.failed,
  });
}

export async function GET(request: NextRequest) {
  return handleCloseBillingCycles(request);
}

export async function POST(request: NextRequest) {
  return handleCloseBillingCycles(request);
}
