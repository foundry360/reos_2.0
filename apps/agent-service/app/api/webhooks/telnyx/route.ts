import { createPublicKey, verify } from "node:crypto";
import { after, NextRequest, NextResponse } from "next/server";
import { getTelnyxCredentials } from "@/lib/admin/platform-credentials";
import { getEnv, mustVerifyWebhookSignature } from "@/lib/env";
import { handleInboundSms, parseTelnyxInboundSms, sendAgentSmsReply } from "@/lib/handle-inbound";

const SIGNATURE_TOLERANCE_SECONDS = 300;

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

  if (mustVerifyWebhookSignature(env.TELNYX_SKIP_SIGNATURE_VERIFY)) {
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

  let event: unknown;
  try {
    event = JSON.parse(rawBody) as unknown;
  } catch {
    return new NextResponse("Invalid JSON", { status: 400 });
  }

  const sms = parseTelnyxInboundSms(event);
  if (!sms) {
    return NextResponse.json({ ok: true });
  }
  // Telnyx retries webhooks that don't get a fast 2xx, so the agent runs after the response.
  // A redelivered message (same Telnyx message id) is a duplicate and sends nothing.
  after(async () => {
    try {
      const result = await handleInboundSms(sms);
      await sendAgentSmsReply(result, sms);
    } catch (error) {
      console.error("Telnyx inbound handling failed:", error);
    }
  });

  return NextResponse.json({ ok: true });
}
