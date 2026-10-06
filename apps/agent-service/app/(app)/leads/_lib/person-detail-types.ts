import type { PersonKind } from "@/lib/crm/person-kind";
import type { ContactType } from "@/lib/crm/contact-type";
import type {
  PersonActivityItem,
  PersonTaskSummary,
} from "@/lib/crm/person-activities";
import type { CrmEmail, EmailRecipient } from "@/lib/email/email-types";
import type { EmailDeliveryStatus } from "@/lib/messaging/send-status-label";

export interface PersonEmail {
  id: string;
  direction: CrmEmail["direction"];
  fromEmail: string;
  fromName: string | null;
  toRecipients: EmailRecipient[];
  ccRecipients: EmailRecipient[];
  subject: string;
  bodyHtml: string | null;
  bodyText: string | null;
  snippet: string | null;
  sentAt: string | null;
  receivedAt: string | null;
  threadId: string | null;
  /** When the record was written: how long a pending email has been sending. */
  createdAt?: string | null;
  /** Outbound only; pending, failed and unknown are appointment emails not confirmed sent (migration 065). */
  sendStatus?: MessageSendStatus | null;
  /** Outbound only: what happened after Resend accepted it, from its signed events (migration 066). */
  deliveryStatus?: EmailDeliveryStatus | null;
}

export interface PersonOpportunitySummary {
  id: string;
  name: string;
  stageLabel: string;
  amountCents: number | null;
  expectedCloseDate: string | null;
  updatedAt: string;
}

export interface PersonMessage {
  id: string;
  channel: string;
  direction: "inbound" | "outbound";
  body: string;
  createdAt: string;
  /** e.g. "Commented on: 123 Main St, Scottsdale · $850K". */
  contextLabel?: string | null;
  /** Outbound only (migration 064); null for inbound and for messages stored before send status existed. */
  sendStatus?: MessageSendStatus | null;
}

export type MessageSendStatus = "pending" | "sent" | "failed" | "unknown";

export function parseSendStatus(value: unknown): MessageSendStatus | null {
  return value === "pending" || value === "sent" || value === "failed" || value === "unknown" ? value : null;
}
export type PersonMessagingChannel = "sms" | "messenger" | "instagram";

export interface PersonMessagingChannelOption {
  channel: PersonMessagingChannel;
  label: string;
  externalId: string;
  /** Tenant channel is connected in admin. */
  connected: boolean;
  /** Connected and this contact can receive on the channel. */
  available: boolean;
  /** Page / IG business profile photo for outbound bubbles. */
  pageAvatarUrl: string | null;
}

export interface PersonDetailData {
  id: string;
  kind: PersonKind;
  name: string;
  firstName: string;
  lastName: string;
  email: string | null;
  phone: string | null;
  avatarUrl: string | null;
  leadStatus: string;
  statusLabel: string;
  contactType: ContactType | null;
  contactTypeLabel: string;
  assignedAgentId: string | null;
  assignedAgentLabel: string | null;
  score: number | null;
  temperature: string | null;
  optedOut: boolean;
  aiSummary: string | null;
  intent: string | null;
  targetLocation: string | null;
  propertyType: string | null;
  budget: string | null;
  timeline: string | null;
  financingStatus: string | null;
  mustHaves: string | null;
  motivation: string | null;
  preferences: string | null;
  agentBrief: string | null;
  recommendedNextAction: string | null;
  createdAt: string;
  updatedAt: string;
  opportunities: PersonOpportunitySummary[];
  tasks: PersonTaskSummary[];
  activities: PersonActivityItem[];
  messages: PersonMessage[];
  messagingChannels: PersonMessagingChannelOption[];
  emails: PersonEmail[];
  emailConnected: boolean;
}

export type { PersonActivityItem, PersonTaskSummary };
