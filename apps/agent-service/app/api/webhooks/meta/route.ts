import { after, NextRequest, NextResponse } from "next/server";
import { getEnv, mustVerifyWebhookSignature } from "@/lib/env";
import { handleInboundMetaMessage } from "@/lib/handle-inbound-meta";
import { handleMetaComment } from "@/lib/handle-meta-comment";
import {
  parseMetaCommentEvents,
  parseMetaWebhookPayload,
  verifyMetaWebhookSignature,
} from "@/lib/meta/webhook";

function cleanParam(value: string | null): string {
  return (value ?? "").trim().replace(/^["']|["']$/g, "");
}

/** Meta webhook verification handshake. */
export async function GET(request: NextRequest) {
  const env = getEnv();
  const mode = cleanParam(request.nextUrl.searchParams.get("hub.mode"));
  const token = cleanParam(request.nextUrl.searchParams.get("hub.verify_token"));
  const challenge = cleanParam(request.nextUrl.searchParams.get("hub.challenge"));
  const expected = cleanParam(env.META_WEBHOOK_VERIFY_TOKEN ?? process.env.META_WEBHOOK_VERIFY_TOKEN ?? "");

  if (mode === "subscribe" && challenge && expected && token === expected) {
    return new NextResponse(challenge, {
      status: 200,
      headers: { "Content-Type": "text/plain; charset=utf-8" },
    });
  }

  return new NextResponse("Forbidden", { status: 403 });
}

/** Inbound Messenger / Instagram messaging events and post comments. */
export async function POST(request: NextRequest) {
  const rawBody = await request.text();
  const signature = request.headers.get("x-hub-signature-256");

  const env = getEnv();
  if (mustVerifyWebhookSignature(!env.META_APP_SECRET)) {
    if (!env.META_APP_SECRET) {
      return new NextResponse("Meta app secret is not configured", { status: 500 });
    }
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
      } else if (message.direction === "inbound" && result.playbook) {
        console.info(
          "Meta agent:",
          message.channel,
          result.playbook,
          result.sent ? "sent" : "no_send",
          result.contactId,
        );
      }
    } catch (error) {
      console.error("Meta inbound error:", error);
    }
  }

  const comments = parseMetaCommentEvents(payload);
  if (comments.length > 0) {
    after(async () => {
      for (const comment of comments) {
        try {
          const result = await handleMetaComment(comment);
          if (!result.ok) {
            console.warn("Meta comment skipped:", result.skipped, comment.platform, comment.accountId);
          } else if (result.agent) {
            console.info("Meta comment:", comment.platform, result.agent, result.detail ?? "", result.contactId);
          }
        } catch (error) {
          console.error("Meta comment error:", error);
        }
      }
    });
  }

  // Always 200 quickly so Meta does not disable the webhook.
  return NextResponse.json({ ok: true });
}
