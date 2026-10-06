import { NextRequest, NextResponse } from "next/server";
import { handleResendWebhook } from "@/lib/email/email-provider-events";
import { getEnv } from "@/lib/env";

/** Signed Resend email events: settle outbound crm_emails records and their delivery status. */
export async function POST(request: NextRequest) {
  const rawBody = await request.text();
  const { status, body } = await handleResendWebhook({
    secret: getEnv().RESEND_WEBHOOK_SECRET,
    headers: request.headers,
    rawBody,
  });
  return NextResponse.json(body, { status });
}
