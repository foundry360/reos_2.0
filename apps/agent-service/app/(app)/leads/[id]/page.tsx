import {
  PersonDetailView,
} from "../_components/person-detail-view";
import { loadPersonDetail } from "../_lib/load-person-detail";
import { listAgentOptionsForTenant } from "@/lib/crm/crm-lists";
import { createClient } from "@/lib/supabase/server";
import { getCurrentProfile } from "@/lib/profile/server";
import { resolveProfileAvatarUrl } from "@/lib/user-display";

interface PageProps {
  params: Promise<{ id: string }>;
}

export default async function LeadDetailPage({ params }: PageProps) {
  const { id } = await params;
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  const [person, agentOptions, profile] = await Promise.all([
    loadPersonDetail(id, "lead"),
    listAgentOptionsForTenant(),
    user ? getCurrentProfile(user.id, user.email ?? "") : Promise.resolve(null),
  ]);

  return (
    <PersonDetailView
      person={person}
      agentOptions={agentOptions}
      currentUser={
        profile
          ? {
              displayName: profile.displayName,
              avatarUrl: resolveProfileAvatarUrl(profile.avatarUrl),
            }
          : undefined
      }
    />
  );
}
