import { NextRequest, NextResponse } from "next/server";
import twilio from "twilio";
import { getTwilioCredentials } from "@/lib/admin/platform-credentials";
import { getEnv } from "@/lib/env";
import { handleInboundSms } from "@/lib/handle-inbound";

function twimlMessage(body: string): string {
  const escaped = body
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
  return `<?xml version="1.0" encoding="UTF-8"?><Response><Message>${escaped}</Message></Response>`;
}

export async function POST(request: NextRequest) {
  const env = getEnv();
  const { authToken } = await getTwilioCredentials();
  const rawBody = await request.text();
  const params = new URLSearchParams(rawBody);

  const from = params.get("From") ?? "";
  const body = params.get("Body") ?? "";
  const to = params.get("To") ?? "";

  if (!env.TWILIO_SKIP_SIGNATURE_VERIFY && authToken) {
    const signature = request.headers.get("x-twilio-signature") ?? "";
    const url = request.url;
    const valid = twilio.validateRequest(
      authToken,
      signature,
      url,
      Object.fromEntries(params),
    );
    if (!valid) {
      return new NextResponse("Invalid signature", { status: 403 });
    }
  }

  const result = await handleInboundSms({ from, body, to });

  if (!result.reply) {
    return new NextResponse("<Response></Response>", {
      status: 200,
      headers: { "Content-Type": "text/xml" },
    });
  }

  return new NextResponse(twimlMessage(result.reply), {
    status: 200,
    headers: { "Content-Type": "text/xml" },
  });
}
