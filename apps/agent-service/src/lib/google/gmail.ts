import { getEnv } from "@/lib/env";
import { getSupabaseAdmin } from "@/lib/supabase/admin";
import type { EmailRecipient } from "@/lib/email/email-types";

type EmailMetadata = {
  access_token?: string;
  refresh_token?: string | null;
  expires_in?: number | null;
  expires_at?: string | null;
  label?: string | null;
};

async function refreshAccessToken(refreshToken: string): Promise<{
  accessToken: string;
  expiresIn: number | null;
} | null> {
  const env = getEnv();
  if (!env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET) return null;

  const response = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: env.GOOGLE_CLIENT_ID,
      client_secret: env.GOOGLE_CLIENT_SECRET,
      refresh_token: refreshToken,
      grant_type: "refresh_token",
    }),
  });

  if (!response.ok) {
    console.error("Gmail token refresh failed:", await response.text());
    return null;
  }

  const data = (await response.json()) as {
    access_token?: string;
    expires_in?: number;
  };
  if (!data.access_token) return null;
  return {
    accessToken: data.access_token,
    expiresIn: data.expires_in ?? null,
  };
}

export async function loadGmailAccount(tenantId: string): Promise<{
  accessToken: string;
  fromEmail: string;
  fromName: string | null;
  metadata: EmailMetadata;
  rowId: string;
} | null> {
  const db = getSupabaseAdmin();
  if (!db) return null;

  const { data } = await db
    .from("channel_accounts")
    .select("id, external_account_id, metadata, status")
    .eq("tenant_id", tenantId)
    .eq("channel", "email")
    .eq("status", "connected")
    .maybeSingle();

  if (!data?.external_account_id) return null;

  const metadata = (data.metadata ?? {}) as EmailMetadata;
  let accessToken = metadata.access_token?.trim() ?? "";
  const refreshToken = metadata.refresh_token?.trim() ?? "";
  const expiresAt = metadata.expires_at
    ? new Date(metadata.expires_at).getTime()
    : 0;
  const needsRefresh =
    !accessToken || (expiresAt > 0 && expiresAt < Date.now() + 60_000);

  if (needsRefresh && refreshToken) {
    const refreshed = await refreshAccessToken(refreshToken);
    if (refreshed) {
      accessToken = refreshed.accessToken;
      const expiresAtIso = refreshed.expiresIn
        ? new Date(Date.now() + refreshed.expiresIn * 1000).toISOString()
        : metadata.expires_at;
      await db
        .from("channel_accounts")
        .update({
          metadata: {
            ...metadata,
            access_token: refreshed.accessToken,
            expires_in: refreshed.expiresIn,
            expires_at: expiresAtIso,
          },
        })
        .eq("id", data.id);
    }
  }

  if (!accessToken) return null;

  return {
    accessToken,
    fromEmail: data.external_account_id.trim(),
    fromName: metadata.label?.trim() || null,
    metadata,
    rowId: data.id,
  };
}

function encodeMimeHeader(value: string): string {
  if (/^[\x20-\x7E]*$/.test(value)) return value;
  return `=?UTF-8?B?${Buffer.from(value, "utf8").toString("base64")}?=`;
}

function formatMimeAddress(recipient: EmailRecipient): string {
  const email = recipient.email.trim();
  const name = recipient.name?.trim();
  if (!name) return email;

  const encodedName = encodeMimeHeader(name);
  if (encodedName !== name || /[",\\]/.test(name)) {
    const escaped = name.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
    return `"${escaped}" <${email}>`;
  }
  return `${name} <${email}>`;
}

function wrapMimeLines(value: string, lineLength = 76): string {
  if (value.length <= lineLength) return value;
  const chunks: string[] = [];
  for (let i = 0; i < value.length; i += lineLength) {
    chunks.push(value.slice(i, i + lineLength));
  }
  return chunks.join("\r\n");
}

function buildMimeMessage(params: {
  fromEmail: string;
  fromName: string | null;
  to: EmailRecipient[];
  cc: EmailRecipient[];
  subject: string;
  bodyHtml: string;
  inReplyTo?: string | null;
}): string {
  const from = params.fromName
    ? `${encodeMimeHeader(params.fromName)} <${params.fromEmail}>`
    : params.fromEmail;
  const to = params.to.map(formatMimeAddress).join(", ");
  const cc = params.cc.map(formatMimeAddress).join(", ");

  const lines = [`From: ${from}`, `To: ${to}`];
  if (cc) lines.push(`Cc: ${cc}`);
  lines.push(`Subject: ${encodeMimeHeader(params.subject)}`);
  if (params.inReplyTo) {
    lines.push(`In-Reply-To: ${params.inReplyTo}`);
    lines.push(`References: ${params.inReplyTo}`);
  }
  lines.push("MIME-Version: 1.0");
  lines.push('Content-Type: text/html; charset="UTF-8"');
  lines.push("Content-Transfer-Encoding: base64");
  lines.push("");
  lines.push(wrapMimeLines(Buffer.from(params.bodyHtml, "utf8").toString("base64")));

  return `${lines.join("\r\n")}\r\n`;
}

function encodeGmailRawMessage(mime: string): string {
  return Buffer.from(mime, "utf8")
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function parseGmailSendError(status: number, body: string): string {
  try {
    const parsed = JSON.parse(body) as {
      error?: {
        message?: string;
        status?: string;
        errors?: Array<{ reason?: string; message?: string }>;
      };
    };
    const message = parsed.error?.message?.trim() ?? "";
    const reason = parsed.error?.errors?.[0]?.reason;

    if (status === 401 || parsed.error?.status === "UNAUTHENTICATED") {
      return "Gmail connection expired. Reconnect Gmail in Admin → Accounts → Connections.";
    }

    if (status === 403) {
      if (
        reason === "accessNotConfigured" ||
        message.includes("Gmail API has not been used") ||
        message.includes("is not enabled")
      ) {
        return "Enable the Gmail API in your Google Cloud project, then try again.";
      }
      if (reason === "insufficientPermissions") {
        return "Gmail send permission is missing. Reconnect Gmail in Admin → Accounts → Connections.";
      }
      return message || "Gmail rejected this send request. Check your connected account permissions.";
    }

    if (message) return message;
  } catch {
    // Fall through to generic message.
  }

  return "Your email provider could not complete the request. Try again.";
}

async function postGmailSend(accessToken: string, raw: string, threadId?: string | null) {
  return fetch("https://gmail.googleapis.com/gmail/v1/users/me/messages/send", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      raw,
      ...(threadId ? { threadId } : {}),
    }),
  });
}

async function latestThreadMessageId(
  accessToken: string,
  threadId: string,
): Promise<string | null> {
  const url = new URL(
    `https://gmail.googleapis.com/gmail/v1/users/me/threads/${encodeURIComponent(threadId)}`,
  );
  url.searchParams.set("format", "metadata");
  url.searchParams.append("metadataHeaders", "Message-ID");
  const response = await fetch(url.toString(), {
    headers: { Authorization: `Bearer ${accessToken}` },
    cache: "no-store",
  });
  if (!response.ok) return null;

  const data = (await response.json()) as {
    messages?: Array<{
      payload?: { headers?: Array<{ name?: string; value?: string }> };
    }>;
  };
  const latest = data.messages?.at(-1);
  return (
    latest?.payload?.headers
      ?.find((entry) => entry.name?.toLowerCase() === "message-id")
      ?.value?.trim() ?? null
  );
}

export async function sendGmailMessage(params: {
  tenantId: string;
  to: EmailRecipient[];
  cc: EmailRecipient[];
  subject: string;
  bodyHtml: string;
  threadId?: string | null;
}): Promise<
  | { ok: true; providerMessageId: string; threadId: string | null }
  | { ok: false; error: string }
> {
  if (params.to.length === 0) {
    return { ok: false, error: "At least one recipient is required." };
  }

  const account = await loadGmailAccount(params.tenantId);
  if (!account) {
    return {
      ok: false,
      error:
        "Gmail is not connected for this workspace. Connect it in Admin → Accounts → Connections.",
    };
  }

  const inReplyTo = params.threadId
    ? await latestThreadMessageId(account.accessToken, params.threadId)
    : null;
  const raw = buildMimeMessage({
    fromEmail: account.fromEmail,
    fromName: account.fromName,
    to: params.to,
    cc: params.cc,
    subject: params.subject,
    bodyHtml: params.bodyHtml,
    inReplyTo,
  });

  const encoded = encodeGmailRawMessage(raw);

  let response = await postGmailSend(account.accessToken, encoded, params.threadId);

  if (response.status === 401) {
    const metadata = account.metadata;
    const refreshToken = metadata.refresh_token?.trim() ?? "";
    if (refreshToken) {
      const refreshed = await refreshAccessToken(refreshToken);
      if (refreshed) {
        const db = getSupabaseAdmin();
        if (db) {
          await db
            .from("channel_accounts")
            .update({
              metadata: {
                ...metadata,
                access_token: refreshed.accessToken,
                expires_in: refreshed.expiresIn,
                expires_at: refreshed.expiresIn
                  ? new Date(Date.now() + refreshed.expiresIn * 1000).toISOString()
                  : metadata.expires_at,
              },
            })
            .eq("id", account.rowId);
        }
        response = await postGmailSend(refreshed.accessToken, encoded, params.threadId);
      }
    }
  }

  if (!response.ok) {
    const body = await response.text();
    console.error("Gmail send failed:", response.status, body);
    return {
      ok: false,
      error: parseGmailSendError(response.status, body),
    };
  }

  const data = (await response.json()) as { id?: string; threadId?: string };
  if (!data.id) {
    return { ok: false, error: "Email wasn't sent. No confirmation from Gmail." };
  }

  return {
    ok: true,
    providerMessageId: data.id,
    threadId: data.threadId ?? params.threadId ?? null,
  };
}

export async function isGmailConnected(tenantId: string): Promise<boolean> {
  const account = await loadGmailAccount(tenantId);
  return account !== null;
}
