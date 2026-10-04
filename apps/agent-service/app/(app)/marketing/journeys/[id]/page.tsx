import { notFound } from "next/navigation";
import { JourneyBuilder } from "../_components/builder/journey-builder";
import { PageHeading } from "@/components/shell/page-heading";
import { IconJourney } from "@/components/shell/sidebar-nav";
import { getJourneyDefinition } from "@/lib/journeys/journey-repository";
import { listAgentOptionsForTenant } from "@/lib/crm/crm-lists";
import { resolveCurrentTenant, workspaceUnavailableMessage } from "@/lib/tenant/current-tenant";
import shell from "@/components/shell/shell.module.css";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface PageProps {
  params: Promise<{ id: string }>;
}

export default async function JourneyBuilderCanvasPage({ params }: PageProps) {
  const { id } = await params;
  if (!UUID_PATTERN.test(id)) notFound();

  const { tenantId, reason } = await resolveCurrentTenant();
  if (!tenantId) {
    return (
      <>
        <div className={shell.pageHeader}>
          <PageHeading icon={<IconJourney />} title="Journey Builder" tone="light" />
        </div>
        <p className={shell.empty}>{workspaceUnavailableMessage(reason)}</p>
      </>
    );
  }

  const [result, agentOptions] = await Promise.all([
    getJourneyDefinition(tenantId, id),
    listAgentOptionsForTenant(),
  ]);
  if (!result.ok) {
    return (
      <>
        <div className={shell.pageHeader}>
          <PageHeading icon={<IconJourney />} title="Journey Builder" tone="light" />
        </div>
        <p className={shell.error}>{result.error}</p>
      </>
    );
  }
  if (!result.value) notFound();

  return <JourneyBuilder journey={result.value} agentOptions={agentOptions} />;
}
