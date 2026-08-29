import { NextRequest, NextResponse } from "next/server";
import { getEnv } from "@/lib/env";
import { handleInboundMetaMessage } from "@/lib/handle-inbound-meta";
import { parseMetaWebhookPayload, verifyMetaWebhookSignature } from "@/lib/meta/webhook";

/** Meta webhook verification handshake. */
export async function GET(request: NextRequest) {
  const env = getEnv();
  const mode = request.nextUrl.searchParams.get("hub.mode");
  const token = request.nextUrl.searchParams.get("hub.verify_token");
  const challenge = request.nextUrl.searchParams.get("hub.challenge");

  if (
    mode === "subscribe" &&
    challenge &&
    env.META_WEBHOOK_VERIFY_TOKEN &&
    token === env.META_WEBHOOK_VERIFY_TOKEN
  ) {
    return new NextResponse(challenge, { status: 200 });
  }

  return new NextResponse("Forbidden", { status: 403 });
}

/** Inbound Messenger / Instagram messaging events. */
export async function POST(request: NextRequest) {
  const rawBody = await request.text();
  const signature = request.headers.get("x-hub-signature-256");

  const env = getEnv();
  if (env.META_APP_SECRET) {
    if (!verifyMetaWebhookSignature(rawBody, signature)) {
      return new NextResponse("Invalid signature", { status: 403 });
    }
  }

  let payload: unknown;
  try {
    payload = JSON.parse(rawBody) as unknown;
  } catch {
    return new NextResponse("Invalid JSON", { status: 400 });
  }

  const messages = parseMetaWebhookPayload(payload);
  for (const message of messages) {
    try {
      const result = await handleInboundMetaMessage(message);
      if (!result.ok) {
        console.warn("Meta inbound skipped:", result.skipped, message.pageOrAccountId);
      }
    } catch (error) {
      console.error("Meta inbound error:", error);
    }
  }

  // Always 200 quickly so Meta does not disable the webhook.
  return NextResponse.json({ ok: true });
}
