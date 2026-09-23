import { getResendApiKey } from "@/lib/admin/resend";
import { getEnv } from "@/lib/env";
import { isValidEmailAddress } from "@/lib/email/email-utils";
import type { EmailRecipient } from "@/lib/email/email-types";
import { buildResendPayload } from "@/lib/email/resend-payload";

export interface ResendSender {
  email: string;
  name: string | null;
}

export function getResendSender(): ResendSender | null {
  const env = getEnv();
  const email = env.RESEND_FROM_EMAIL?.trim().toLowerCase() ?? "";
  if (!email || !isValidEmailAddress(email)) return null;
  return {
    email,
    name: env.RESEND_FROM_NAME?.trim() || null,
  };
}

export async function isResendEmailConfigured(): Promise<boolean> {
  return Boolean((await getResendApiKey()) && getResendSender());
}

export async function sendResendMessage(params: {
  to: EmailRecipient[];
  cc: EmailRecipient[];
  subject: string;
  bodyHtml: string;
  replyTo: string;
  agentName: string;
}): Promise<
  | {
      ok: true;
      providerMessageId: string;
      fromEmail: string;
      fromName: string;
    }
  | { ok: false; error: string }
> {
  const apiKey = await getResendApiKey();
  const sender = getResendSender();
  if (!apiKey || !sender) {
    return {
      ok: false,
      error:
        "Email sending is not configured for this workspace yet.",
    };
  }

  const { payload, fromName } = buildResendPayload({
    senderEmail: sender.email,
    senderProductName: sender.name || "REOS",
    agentName: params.agentName,
    agentEmail: params.replyTo,
    to: params.to,
    cc: params.cc,
    subject: params.subject,
    bodyHtml: params.bodyHtml,
  });
  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });

  const data = (await response.json().catch(() => null)) as {
    id?: string;
    message?: string;
    name?: string;
  } | null;

  if (!response.ok || !data?.id) {
    console.warn("Resend email send failed:", response.status, data?.name);
    return {
      ok: false,
      error: data?.message?.trim() || "Could not send email through REOS.",
    };
  }

  return {
    ok: true,
    providerMessageId: data.id,
    fromEmail: sender.email,
    fromName,
  };
}
