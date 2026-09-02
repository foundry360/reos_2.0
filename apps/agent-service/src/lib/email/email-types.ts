export type EmailProvider = "gmail" | "outlook";

export type EmailDirection = "outbound" | "inbound";

export type EmailStatus = "draft" | "queued" | "sent" | "failed" | "received";

export interface EmailRecipient {
  email: string;
  name?: string | null;
}

export type {
  EmailIntelligence,
  EmailIntelligenceAction,
  EmailIntelligenceInput,
  EmailIntelligenceSignal,
  EmailIntelligenceStatus,
  EmailIntelligenceUrgency,
} from "@/lib/email/email-intelligence";

export interface CrmEmail {
  id: string;
  contactId: string | null;
  opportunityId: string | null;
  provider: EmailProvider;
  providerMessageId: string | null;
  threadId: string | null;
  direction: EmailDirection;
  fromEmail: string;
  fromName: string | null;
  toRecipients: EmailRecipient[];
  ccRecipients: EmailRecipient[];
  subject: string;
  bodyHtml: string | null;
  bodyText: string | null;
  snippet: string | null;
  status: EmailStatus;
  sentAt: string | null;
  receivedAt: string | null;
  hasAttachments: boolean;
}

export interface EmailConnectedAccount {
  provider: EmailProvider;
  email: string;
  label: string | null;
}

export interface EmailComposeContext {
  contactId?: string;
  contactName?: string;
  contactEmail?: string | null;
  opportunityId?: string;
  opportunityName?: string;
  threadId?: string;
}

export interface EmailComposeDraft {
  to: string;
  cc: string;
  subject: string;
  bodyHtml: string;
}

export interface SendEmailInput {
  to: string;
  cc?: string;
  subject: string;
  bodyHtml: string;
  contactId?: string;
  opportunityId?: string;
  threadId?: string;
}

export interface SendEmailResult {
  ok: boolean;
  error?: string;
  emailId?: string;
}

export interface EmailComposeBootstrap {
  connected: boolean;
  accounts: EmailConnectedAccount[];
  signature: string | null;
  showAdminConnect: boolean;
}
