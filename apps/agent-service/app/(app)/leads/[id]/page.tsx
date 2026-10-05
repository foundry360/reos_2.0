import {
  PersonDetailView,
} from "../_components/person-detail-view";
import { loadPersonDetail } from "../_lib/load-person-detail";
import { listAgentOptionsForTenant } from "@/lib/crm/crm-lists";
import { createClient } from "@/lib/supabase/server";
import { getCurrentProfile } from "@/lib/profile/server";
import { resolveProfileAvatarUrl } from "@/lib/user-display";
import { resolveCurrentTenant } from "@/lib/tenant/current-tenant";
import { listManualEnrollmentJourneys } from "@/lib/journeys/journey-repository";
import type { JourneyEnrollmentChoices } from "../_components/enroll-in-journey";

interface PageProps {
  params: Promise<{ id: string }>;
}

async function loadEnrollmentChoices(contactId: string): Promise<JourneyEnrollmentChoices> {
  const { tenantId } = await resolveCurrentTenant();
  if (!tenantId) return { journeys: [], loadFailed: true };
  const result = await listManualEnrollmentJourneys(tenantId, contactId);
  return result.ok ? { journeys: result.value, loadFailed: false } : { journeys: [], loadFailed: true };
}

export default async function LeadDetailPage({ params }: PageProps) {
  const { id } = await params;
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  const [person, agentOptions, profile, journeyEnrollment] = await Promise.all([
    loadPersonDetail(id, "lead"),
    listAgentOptionsForTenant(),
    user ? getCurrentProfile(user.id, user.email ?? "") : Promise.resolve(null),
    loadEnrollmentChoices(id),
  ]);

  return (
    <PersonDetailView
      person={person}
      agentOptions={agentOptions}
      journeyEnrollment={journeyEnrollment}
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
