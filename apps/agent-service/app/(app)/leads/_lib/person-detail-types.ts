import type { PersonKind } from "@/lib/crm/person-kind";
import type { ContactType } from "@/lib/crm/contact-type";
import type {
  PersonActivityItem,
  PersonTaskSummary,
} from "@/lib/crm/person-activities";

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
}

export type { PersonActivityItem, PersonTaskSummary };
