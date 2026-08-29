import { notFound } from "next/navigation";
import { fetchOpportunityById } from "@/lib/opportunities/opportunities-list";
import { resolveCurrentTenant } from "@/lib/tenant/current-tenant";
import {
  listAgentOptionsForTenant,
  listLeadOptionsForTenant,
} from "@/lib/crm/crm-lists";
import {
  fetchActivitiesForOpportunity,
  fetchTasksForOpportunity,
} from "@/lib/crm/person-activity-lists";
import type {
  PersonActivityItem,
  PersonTaskSummary,
} from "@/lib/crm/person-activities";
import type { OpportunityRow } from "@/lib/opportunities/opportunities-types";

export interface OpportunityDetailData {
  opportunity: OpportunityRow;
  agentLabel: string | null;
  contactOptions: { id: string; label: string }[];
  agentOptions: { id: string; label: string }[];
  activities: PersonActivityItem[];
  tasks: PersonTaskSummary[];
}

export async function loadOpportunityDetail(id: string): Promise<OpportunityDetailData> {
  const { tenantId } = await resolveCurrentTenant();
  if (!tenantId) notFound();

  const [opportunity, contactOptions, agentOptions] = await Promise.all([
    fetchOpportunityById(tenantId, id),
    listLeadOptionsForTenant(),
    listAgentOptionsForTenant(),
  ]);

  if (!opportunity) notFound();

  const [activities, tasks] = await Promise.all([
    fetchActivitiesForOpportunity(tenantId, opportunity.id, {
      contactId: opportunity.contactId,
      opportunityName: opportunity.name,
    }),
    fetchTasksForOpportunity(tenantId, opportunity.id),
  ]);

  const agentLabel =
    opportunity.assignedAgentId != null
      ? (agentOptions.find((option) => option.id === opportunity.assignedAgentId)?.label ??
        null)
      : null;

  return {
    opportunity,
    agentLabel,
    contactOptions,
    agentOptions,
    activities,
    tasks,
  };
}
