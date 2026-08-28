import type { PersonKind } from "@/lib/crm/person-kind";

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
  score: number | null;
  temperature: string | null;
  optedOut: boolean;
  aiSummary: string | null;
  createdAt: string;
  updatedAt: string;
}
