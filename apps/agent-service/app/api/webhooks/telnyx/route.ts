import { createPublicKey, verify } from "node:crypto";
import { after, NextRequest, NextResponse } from "next/server";
import { getTelnyxCredentials } from "@/lib/admin/platform-credentials";
import { getEnv } from "@/lib/env";
import { handleInboundSms } from "@/lib/handle-inbound";
import { sendSmsMessage } from "@/lib/messaging/send-sms";

const SIGNATURE_TOLERANCE_SECONDS = 300;

interface TelnyxMessageEvent {
  data?: {
    event_type?: string;
    payload?: {
      direction?: string;
      text?: string;
      from?: { phone_number?: string };
      to?: Array<{ phone_number?: string }>;
    };
  };
}

function verifyTelnyxSignature(input: {
  rawBody: string;
  signature: string;
  timestamp: string;
  publicKey: string;
}): boolean {
  const timestampSeconds = Number(input.timestamp);
  if (!Number.isFinite(timestampSeconds)) return false;
  if (Math.abs(Date.now() / 1000 - timestampSeconds) > SIGNATURE_TOLERANCE_SECONDS) {
    return false;
  }

  try {
    const key = createPublicKey({
      key: {
        kty: "OKP",
        crv: "Ed25519",
        x: Buffer.from(input.publicKey, "base64").toString("base64url"),
      },
      format: "jwk",
    });
    return verify(
      null,
      Buffer.from(`${input.timestamp}|${input.rawBody}`),
      key,
      Buffer.from(input.signature, "base64"),
    );
  } catch {
    return false;
  }
}

export async function POST(request: NextRequest) {
  const env = getEnv();
  const rawBody = await request.text();

  if (!env.TELNYX_SKIP_SIGNATURE_VERIFY) {
    const { publicKey } = await getTelnyxCredentials();
    if (!publicKey) {
      return new NextResponse("Telnyx public key is not configured", { status: 500 });
    }
    const valid = verifyTelnyxSignature({
      rawBody,
      signature: request.headers.get("telnyx-signature-ed25519") ?? "",
      timestamp: request.headers.get("telnyx-timestamp") ?? "",
      publicKey,
    });
    if (!valid) {
      return new NextResponse("Invalid signature", { status: 403 });
    }
  }

  let event: TelnyxMessageEvent;
  try {
    event = JSON.parse(rawBody) as TelnyxMessageEvent;
  } catch {
    return new NextResponse("Invalid JSON", { status: 400 });
  }

  const payload = event.data?.payload;
  if (event.data?.event_type !== "message.received" || payload?.direction !== "inbound") {
    return NextResponse.json({ ok: true });
  }

  const from = payload.from?.phone_number ?? "";
  const to = payload.to?.[0]?.phone_number ?? "";
  const body = payload.text ?? "";

  // Telnyx retries webhooks that don't get a fast 2xx, so the agent runs after the response.
  after(async () => {
    try {
      const result = await handleInboundSms({ from, body, to });
      if (!result.reply || !to) return;

      const sent = await sendSmsMessage({ fromE164: to, toE164: from, body: result.reply });
      if (!sent.ok) {
        console.error("Telnyx reply send failed:", sent.error);
      }
    } catch (error) {
      console.error("Telnyx inbound handling failed:", error);
    }
  });

  return NextResponse.json({ ok: true });
}
