import type { LeadStatus } from "@/lib/coordinator";
import type { ContactType } from "@/lib/crm/contact-type";
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
  contactType: ContactType | null;
  qualificationScore: number | null;
  leadTemperature: "Hot" | "Warm" | "Cold" | null;
  optedOut: boolean;
  createdAt: string;
  updatedAt: string;
}
