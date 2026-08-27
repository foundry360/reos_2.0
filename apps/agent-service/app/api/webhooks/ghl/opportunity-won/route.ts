import { NextRequest, NextResponse } from "next/server";
import {
  isGhlProvisionError,
  parseGhlOpportunityWonPayload,
  provisionTenantFromGhlOpportunityWon,
} from "@/lib/admin/ghl-provisioning";
import { getEnv } from "@/lib/env";

function readWebhookSecret(request: NextRequest): string | null {
  const headerSecret =
    request.headers.get("x-reos-webhook-secret") ??
    request.headers.get("x-ghl-webhook-secret");

  if (headerSecret?.trim()) return headerSecret.trim();

  const authorization = request.headers.get("authorization");
  if (authorization?.toLowerCase().startsWith("bearer ")) {
    return authorization.slice(7).trim();
  }

  return null;
}

function unauthorized() {
  return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
}

export async function POST(request: NextRequest) {
  const configuredSecret = getEnv().GHL_WEBHOOK_SECRET?.trim();
  if (!configuredSecret) {
    return NextResponse.json({ error: "GHL webhook secret is not configured." }, { status: 501 });
  }

  const providedSecret = readWebhookSecret(request);
  if (!providedSecret || providedSecret !== configuredSecret) {
    return unauthorized();
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  const parsed = parseGhlOpportunityWonPayload(body);
  if (isGhlProvisionError(parsed)) {
    return NextResponse.json({ error: parsed.error }, { status: parsed.status });
  }

  const result = await provisionTenantFromGhlOpportunityWon(parsed);
  if (!result.ok) {
    return NextResponse.json({ error: result.error }, { status: result.status });
  }

  return NextResponse.json({
    ok: true,
    tenantId: result.tenantId,
    slug: result.slug,
    created: result.created,
    adminUrl: `/admin/accounts/${result.tenantId}`,
  });
}
