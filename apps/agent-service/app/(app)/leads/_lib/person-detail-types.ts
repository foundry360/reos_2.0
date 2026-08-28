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

export interface PersonDetailData {
  id: string;
  kind: PersonKind;
  name: string;
  firstName: string;
  lastName: string;
  email: string | null;
  phone: string | null;
  leadStatus: string;
  statusLabel: string;
  contactType: ContactType | null;
  contactTypeLabel: string;
  score: number | null;
  temperature: string | null;
  optedOut: boolean;
  aiSummary: string | null;
  createdAt: string;
  updatedAt: string;
  opportunities: PersonOpportunitySummary[];
  tasks: PersonTaskSummary[];
  activities: PersonActivityItem[];
}

export type { PersonActivityItem, PersonTaskSummary };
