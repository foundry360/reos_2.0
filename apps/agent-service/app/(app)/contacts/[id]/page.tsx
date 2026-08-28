import { PersonDetailView } from "../../leads/_components/person-detail-view";
import { loadPersonDetail } from "../../leads/_lib/load-person-detail";

interface PageProps {
  params: Promise<{ id: string }>;
}

export default async function ContactDetailPage({ params }: PageProps) {
  const { id } = await params;
  const person = await loadPersonDetail(id, "contact");
  return <PersonDetailView person={person} />;
}
