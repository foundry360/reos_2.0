import type {
  OpportunityPipeline,
  OpportunityStage,
} from "@/lib/opportunities/opportunity-stages";
import type {
  OpportunityLeadSource,
  OpportunityPriority,
  OpportunityType,
} from "@/lib/opportunities/opportunity-fields";

export interface OpportunityRow {
  id: string;
  name: string;
  pipeline: OpportunityPipeline;
  stage: OpportunityStage;
  stageLabel: string;
  opportunityType: OpportunityType;
  leadSource: OpportunityLeadSource | null;
  priority: OpportunityPriority | null;
  assignedAgentId: string | null;
  amountCents: number | null;
  expectedCloseDate: string | null;
  contactId: string | null;
  contactName: string | null;
  contactEmail: string | null;
  contactRecordType: "lead" | "contact" | null;
  notes: string | null;
  createdAt: string;
  updatedAt: string;
}
