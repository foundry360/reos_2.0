import { OpportunityDetailView } from "../_components/opportunity-detail-view";
import { loadOpportunityDetail } from "../_lib/load-opportunity-detail";

interface PageProps {
  params: Promise<{ id: string }>;
}

export default async function OpportunityDetailPage({ params }: PageProps) {
  const { id } = await params;
  const detail = await loadOpportunityDetail(id);
  return (
    <OpportunityDetailView
      opportunity={detail.opportunity}
      agentLabel={detail.agentLabel}
      contactOptions={detail.contactOptions}
      agentOptions={detail.agentOptions}
      activities={detail.activities}
      tasks={detail.tasks}
    />
  );
}
