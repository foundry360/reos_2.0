import { loadGmailAccount } from "@/lib/google/gmail";
import {
  buildGmailDirectContactSearchQuery,
  isDirectContactConversation,
  normalizeEmailAddress,
  parseRecipientList,
} from "@/lib/email/email-utils";
import { recordInboundCrmEmail } from "@/lib/email/record-inbound-email";
import { getSupabaseAdmin } from "@/lib/supabase/admin";

type GmailHeader = { name?: string; value?: string };
type GmailPart = {
  mimeType?: string;
  body?: { data?: string };
  parts?: GmailPart[];
};
type GmailMessage = {
  id?: string;
  threadId?: string;
  internalDate?: string;
  snippet?: string;
  payload?: GmailPart & { headers?: GmailHeader[] };
};
type GmailThread = { messages?: GmailMessage[] };

function decodeBase64Url(value?: string): string | null {
  if (!value) return null;
  try {
    const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
    return Buffer.from(normalized, "base64").toString("utf8");
  } catch {
    return null;
  }
}

function findBody(part: GmailPart | undefined, mimeType: string): string | null {
  if (!part) return null;
  if (part.mimeType === mimeType && part.body?.data) {
    return decodeBase64Url(part.body.data);
  }
  for (const child of part.parts ?? []) {
    const body = findBody(child, mimeType);
    if (body) return body;
  }
  return null;
}

function header(headers: GmailHeader[] | undefined, name: string): string {
  return (
    headers?.find((entry) => entry.name?.toLowerCase() === name.toLowerCase())
      ?.value?.trim() ?? ""
  );
}

function firstAddress(raw: string): { email: string; name: string | null } | null {
  const recipient = parseRecipientList(raw)[0];
  if (!recipient) return null;
  return { email: recipient.email, name: recipient.name?.trim() || null };
}

async function gmailFetchJson<T>(
  accessToken: string,
  url: string,
): Promise<T | null> {
  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${accessToken}` },
    cache: "no-store",
  });
  if (!response.ok) {
    console.error("Gmail sync request failed:", response.status, await response.text());
    return null;
  }
  return (await response.json()) as T;
}

type ParsedGmailMessage = {
  id: string;
  threadId: string | null;
  from: { email: string; name: string | null };
  to: ReturnType<typeof parseRecipientList>;
  cc: ReturnType<typeof parseRecipientList>;
  subject: string;
  bodyHtml: string | null;
  bodyText: string | null;
  snippet: string | null;
  timestamp: string;
};

function parseGmailMessage(message: GmailMessage): ParsedGmailMessage | null {
  if (!message.id || !message.payload) return null;

  const headers = message.payload.headers;
  const from = firstAddress(header(headers, "From"));
  if (!from) return null;

  return {
    id: message.id,
    threadId: message.threadId ?? null,
    from,
    to: parseRecipientList(header(headers, "To")),
    cc: parseRecipientList(header(headers, "Cc")),
    subject: header(headers, "Subject") || "(No subject)",
    bodyHtml: findBody(message.payload, "text/html"),
    bodyText:
      findBody(message.payload, "text/plain") ??
      (message.payload.mimeType === "text/plain"
        ? decodeBase64Url(message.payload.body?.data)
        : null),
    snippet: message.snippet ?? null,
    timestamp: message.internalDate
      ? new Date(Number(message.internalDate)).toISOString()
      : new Date().toISOString(),
  };
}

async function importGmailMessage(params: {
  parsed: ParsedGmailMessage;
  tenantId: string;
  contactId: string;
  contactEmail: string;
  agentEmail: string;
  opportunityId?: string | null;
  db: NonNullable<ReturnType<typeof getSupabaseAdmin>>;
  existing: Set<string>;
}): Promise<void> {
  const { parsed, tenantId, contactId, contactEmail, agentEmail, opportunityId, db, existing } =
    params;
  if (existing.has(parsed.id)) return;

  if (
    !isDirectContactConversation({
      contactEmail,
      agentEmail,
      fromEmail: parsed.from.email,
      toRecipients: parsed.to,
      ccRecipients: parsed.cc,
    })
  ) {
    return;
  }

  existing.add(parsed.id);

  const inbound =
    normalizeEmailAddress(parsed.from.email) !== normalizeEmailAddress(agentEmail);

  if (inbound) {
    await recordInboundCrmEmail({
      tenantId,
      contactId,
      opportunityId,
      providerMessageId: parsed.id,
      threadId: parsed.threadId,
      fromEmail: parsed.from.email,
      fromName: parsed.from.name,
      toRecipients: parsed.to,
      ccRecipients: parsed.cc,
      subject: parsed.subject,
      bodyHtml: parsed.bodyHtml,
      bodyText: parsed.bodyText,
      snippet: parsed.snippet,
      receivedAt: parsed.timestamp,
    });
    return;
  }

  const { error } = await db.from("crm_emails").insert({
    tenant_id: tenantId,
    contact_id: contactId,
    opportunity_id: opportunityId ?? null,
    provider: "gmail",
    provider_message_id: parsed.id,
    thread_id: parsed.threadId,
    direction: "outbound",
    from_email: parsed.from.email,
    from_name: parsed.from.name,
    to_recipients: parsed.to,
    cc_recipients: parsed.cc,
    subject: parsed.subject,
    body_html: parsed.bodyHtml,
    body_text: parsed.bodyText,
    snippet: parsed.snippet,
    status: "sent",
    sent_at: parsed.timestamp,
  });
  if (error) console.error("Gmail outbound sync insert failed:", error.message);
}

/**
 * Sync Gmail messages for one CRM contact: refresh known threads plus recent
 * direct 1:1 mail (last 30 days). Skips group/CC inbox imports.
 */
export async function syncContactGmailMessages(params: {
  tenantId: string;
  contactId: string;
  contactEmail: string;
  opportunityId?: string | null;
}): Promise<void> {
  const account = await loadGmailAccount(params.tenantId);
  const db = getSupabaseAdmin();
  if (!account || !db) return;

  const contactEmail = params.contactEmail.trim();
  const agentEmail = account.fromEmail.trim();
  if (normalizeEmailAddress(contactEmail) === normalizeEmailAddress(agentEmail)) {
    return;
  }

  const { data: tenantRows } = await db
    .from("crm_emails")
    .select("provider_message_id")
    .eq("tenant_id", params.tenantId)
    .eq("provider", "gmail")
    .not("provider_message_id", "is", null);

  const existing = new Set(
    (tenantRows ?? []).map((row) => row.provider_message_id).filter(Boolean) as string[],
  );

  const { data: contactRows } = await db
    .from("crm_emails")
    .select("thread_id")
    .eq("tenant_id", params.tenantId)
    .eq("contact_id", params.contactId)
    .eq("provider", "gmail");

  const threadIds = [
    ...new Set(
      (contactRows ?? [])
        .map((row) => row.thread_id)
        .filter((id): id is string => Boolean(id)),
    ),
  ];

  for (const threadId of threadIds) {
    const thread = await gmailFetchJson<GmailThread>(
      account.accessToken,
      `https://gmail.googleapis.com/gmail/v1/users/me/threads/${encodeURIComponent(threadId)}?format=full`,
    );

    for (const message of thread?.messages ?? []) {
      const parsed = parseGmailMessage(message);
      if (!parsed) continue;
      await importGmailMessage({
        parsed,
        tenantId: params.tenantId,
        contactId: params.contactId,
        contactEmail,
        agentEmail,
        opportunityId: params.opportunityId,
        db,
        existing,
      });
    }
  }

  const query = encodeURIComponent(
    `${buildGmailDirectContactSearchQuery(contactEmail)} newer_than:30d`,
  );
  const listed = await gmailFetchJson<{ messages?: Array<{ id?: string }> }>(
    account.accessToken,
    `https://gmail.googleapis.com/gmail/v1/users/me/messages?q=${query}&maxResults=15`,
  );

  for (const row of listed?.messages ?? []) {
    if (!row.id || existing.has(row.id)) continue;

    const message = await gmailFetchJson<GmailMessage>(
      account.accessToken,
      `https://gmail.googleapis.com/gmail/v1/users/me/messages/${encodeURIComponent(row.id)}?format=full`,
    );
    const parsed = message ? parseGmailMessage(message) : null;
    if (!parsed) continue;

    await importGmailMessage({
      parsed,
      tenantId: params.tenantId,
      contactId: params.contactId,
      contactEmail,
      agentEmail,
      opportunityId: params.opportunityId,
      db,
      existing,
    });
  }
}
