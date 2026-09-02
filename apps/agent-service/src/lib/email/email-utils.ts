import type { EmailRecipient } from "@/lib/email/email-types";

const EMAIL_RE = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/;

export function parseRecipientList(raw: string): EmailRecipient[] {
  const parts = raw
    .split(/[,;]/)
    .map((part) => part.trim())
    .filter(Boolean);

  const recipients: EmailRecipient[] = [];
  for (const part of parts) {
    const angle = part.match(/^(.+?)\s*<([^>]+)>$/);
    if (angle) {
      const email = angle[2].trim().toLowerCase();
      if (EMAIL_RE.test(email)) {
        recipients.push({ name: angle[1].trim(), email });
      }
      continue;
    }
    const email = part.toLowerCase();
    if (EMAIL_RE.test(email)) {
      recipients.push({ email });
    }
  }
  return recipients;
}

export function formatRecipient(recipient: EmailRecipient): string {
  if (recipient.name) return `${recipient.name} <${recipient.email}>`;
  return recipient.email;
}

export function formatRecipientList(recipients: EmailRecipient[]): string {
  return recipients.map(formatRecipient).join(", ");
}

export function htmlToPlainText(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n\n")
    .replace(/<\/div>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function buildEmailSnippet(bodyHtml: string, maxLen = 160): string {
  const text = htmlToPlainText(bodyHtml);
  if (text.length <= maxLen) return text;
  return `${text.slice(0, maxLen - 1).trim()}…`;
}

export function isValidEmailAddress(value: string): boolean {
  return EMAIL_RE.test(value.trim().toLowerCase());
}

export function normalizeEmailAddress(value: string): string {
  return value.trim().toLowerCase();
}

export function recipientsIncludeEmail(
  recipients: EmailRecipient[],
  email: string,
): boolean {
  const needle = normalizeEmailAddress(email);
  return recipients.some(
    (recipient) => normalizeEmailAddress(recipient.email) === needle,
  );
}

/** True when the contact appears in From, To, or Cc. */
export function emailInvolvesContact(params: {
  contactEmail: string;
  fromEmail: string;
  toRecipients: EmailRecipient[];
  ccRecipients?: EmailRecipient[];
}): boolean {
  const needle = normalizeEmailAddress(params.contactEmail);
  if (normalizeEmailAddress(params.fromEmail) === needle) return true;
  if (recipientsIncludeEmail(params.toRecipients, needle)) return true;
  if (params.ccRecipients && recipientsIncludeEmail(params.ccRecipients, needle)) {
    return true;
  }
  return false;
}

function escapeGmailSearchTerm(term: string): string {
  return term.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

/** Strip Re:/Fwd: prefixes for matching replies to the same conversation. */
export function normalizeEmailSubject(subject: string): string {
  let value = subject.trim();
  for (let i = 0; i < 5; i++) {
    const next = value.replace(/^(re|fwd|fw):\s*/i, "").trim();
    if (next === value) break;
    value = next;
  }
  return value.toLowerCase();
}

/** Display label for a conversation row (no Re:/Fwd: prefix). */
export function conversationSubjectLabel(subject: string): string {
  let value = subject.trim();
  for (let i = 0; i < 5; i++) {
    const next = value.replace(/^(re|fwd|fw):\s*/i, "").trim();
    if (next === value) break;
    value = next;
  }
  return value || subject.trim() || "(No subject)";
}

class ConversationUnionFind {
  private parent = new Map<string, string>();

  find(key: string): string {
    if (!this.parent.has(key)) this.parent.set(key, key);
    const parent = this.parent.get(key)!;
    if (parent !== key) {
      const root = this.find(parent);
      this.parent.set(key, root);
      return root;
    }
    return key;
  }

  union(a: string, b: string): void {
    const rootA = this.find(a);
    const rootB = this.find(b);
    if (rootA !== rootB) this.parent.set(rootB, rootA);
  }
}

export function groupEmailsIntoConversations<T extends {
  id: string;
  subject: string;
  threadId: string | null;
  sentAt: string | null;
  receivedAt: string | null;
}>(emails: T[]): Array<{ id: string; messages: T[] }> {
  if (emails.length === 0) return [];

  const uf = new ConversationUnionFind();

  for (const email of emails) {
    const emailKey = `email:${email.id}`;
    if (email.threadId) uf.union(emailKey, `thread:${email.threadId}`);
    const normalized = normalizeEmailSubject(email.subject);
    if (normalized) uf.union(emailKey, `subject:${normalized}`);
  }

  const groups = new Map<string, T[]>();
  for (const email of emails) {
    const root = uf.find(`email:${email.id}`);
    const current = groups.get(root) ?? [];
    current.push(email);
    groups.set(root, current);
  }

  return [...groups.entries()]
    .map(([id, messages]) => ({
      id,
      messages: messages.sort(
        (a, b) =>
          new Date(a.sentAt ?? a.receivedAt ?? 0).getTime() -
          new Date(b.sentAt ?? b.receivedAt ?? 0).getTime(),
      ),
    }))
    .sort((a, b) => {
      const aLatest = a.messages.at(-1);
      const bLatest = b.messages.at(-1);
      return (
        new Date(bLatest?.sentAt ?? bLatest?.receivedAt ?? 0).getTime() -
        new Date(aLatest?.sentAt ?? aLatest?.receivedAt ?? 0).getTime()
      );
    });
}

/** Gmail search for direct 1:1 messages between the connected inbox and a contact. */
export function buildGmailDirectContactSearchQuery(contactEmail: string): string {
  const quoted = escapeGmailSearchTerm(normalizeEmailAddress(contactEmail));
  return `(from:"${quoted}" to:me) OR (from:me to:"${quoted}")`;
}

/**
 * True for direct contact ↔ agent conversations only.
 * Inbound from contact requires the agent in To/Cc; outbound requires contact in To.
 */
export function isDirectContactConversation(params: {
  contactEmail: string;
  agentEmail: string;
  fromEmail: string;
  toRecipients: EmailRecipient[];
  ccRecipients?: EmailRecipient[];
}): boolean {
  const contact = normalizeEmailAddress(params.contactEmail);
  const agent = normalizeEmailAddress(params.agentEmail);
  const from = normalizeEmailAddress(params.fromEmail);

  if (from === contact) {
    if (recipientsIncludeEmail(params.toRecipients, agent)) return true;
    if (params.ccRecipients && recipientsIncludeEmail(params.ccRecipients, agent)) {
      return true;
    }
    return false;
  }
  if (from === agent) return recipientsIncludeEmail(params.toRecipients, contact);
  return false;
}

export function contactPrefillRecipient(name: string, email: string): string {
  const trimmedName = name.trim();
  const trimmedEmail = email.trim().toLowerCase();
  if (!trimmedName) return trimmedEmail;
  return `${trimmedName} <${trimmedEmail}>`;
}

export function formatSignatureHtml(signature: string): string {
  const escaped = signature
    .trim()
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\n/g, "<br>");
  return `<p><br></p><p>--</p><p>${escaped}</p>`;
}
