import { PersonDetailView } from "../../leads/_components/person-detail-view";
import { loadPersonDetail } from "../../leads/_lib/load-person-detail";
import { listAgentOptionsForTenant } from "@/lib/crm/crm-lists";

interface PageProps {
  params: Promise<{ id: string }>;
}

export default async function ContactDetailPage({ params }: PageProps) {
  const { id } = await params;
  const [person, agentOptions] = await Promise.all([
    loadPersonDetail(id, "contact"),
    listAgentOptionsForTenant(),
  ]);
  return <PersonDetailView person={person} agentOptions={agentOptions} />;
}
