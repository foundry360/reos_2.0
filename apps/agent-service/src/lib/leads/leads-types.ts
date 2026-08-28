import type { LeadStatus } from "@/lib/coordinator";
import type { PersonKind } from "@/lib/crm/person-kind";

export interface LeadRow {
  id: string;
  name: string;
  firstName: string | null;
  lastName: string | null;
  phone: string | null;
  email: string | null;
  recordType: PersonKind;
  leadStatus: LeadStatus;
  leadStatusLabel: string;
  qualificationScore: number | null;
  leadTemperature: "Hot" | "Warm" | "Cold" | null;
  optedOut: boolean;
  createdAt: string;
  updatedAt: string;
}
