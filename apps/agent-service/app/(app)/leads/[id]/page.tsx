import {
  PersonDetailView,
} from "../_components/person-detail-view";
import { loadPersonDetail } from "../_lib/load-person-detail";

interface PageProps {
  params: Promise<{ id: string }>;
}

export default async function LeadDetailPage({ params }: PageProps) {
  const { id } = await params;
  const person = await loadPersonDetail(id, "lead");
  return <PersonDetailView person={person} />;
}
