import {
  PersonDetailView,
} from "../_components/person-detail-view";
import { loadPersonDetail } from "../_lib/load-person-detail";
import { listAgentOptionsForTenant } from "@/lib/crm/crm-lists";

interface PageProps {
  params: Promise<{ id: string }>;
}

export default async function LeadDetailPage({ params }: PageProps) {
  const { id } = await params;
  const [person, agentOptions] = await Promise.all([
    loadPersonDetail(id, "lead"),
    listAgentOptionsForTenant(),
  ]);
  return <PersonDetailView person={person} agentOptions={agentOptions} />;
}
