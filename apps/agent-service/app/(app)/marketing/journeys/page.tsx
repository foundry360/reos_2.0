import { CreateJourneyModal } from "./_components/create-journey-modal";
import { JourneysTable } from "./_components/journeys-table";
import { EmptyState } from "@/components/shell/empty-state";
import { PageHeading } from "@/components/shell/page-heading";
import { IconJourney } from "@/components/shell/sidebar-nav";
import { listJourneys } from "@/lib/journeys/journey-repository";
import { resolveCurrentTenant, workspaceUnavailableMessage } from "@/lib/tenant/current-tenant";
import shell from "@/components/shell/shell.module.css";
import styles from "./_components/journeys.module.css";

const SUBTITLE =
  "Journeys let agents and teams automate customer engagement and business processes, from first touch to closing.";

export default async function JourneyBuilderPage() {
  const { tenantId, reason } = await resolveCurrentTenant();

  const heading = (
    <PageHeading icon={<IconJourney />} title="Journey Builder" subtitle={SUBTITLE} tone="light" />
  );

  if (!tenantId) {
    return (
      <>
        <div className={shell.pageHeader}>{heading}</div>
        <p className={shell.empty}>{workspaceUnavailableMessage(reason)}</p>
      </>
    );
  }

  const result = await listJourneys(tenantId);
  const journeys = result.ok ? result.value : [];

  return (
    <>
      <div className={shell.pageHeader}>
        {heading}
        {journeys.length > 0 ? (
          <div className={shell.pageHeaderActions}>
            <CreateJourneyModal />
          </div>
        ) : null}
      </div>

      {!result.ok ? (
        <p className={shell.error}>{result.error}</p>
      ) : journeys.length === 0 ? (
        <EmptyState
          title="Build your first journey"
          description="Map how leads move through your business, from the event that starts a journey to the actions that follow. Start blank or explore the New Lead Qualification example."
          action={
            <div className={styles.journeyEmptyActions}>
              <CreateJourneyModal trigger="cta" />
              <CreateJourneyModal
                trigger="secondary"
                label="Use New Lead Qualification example"
                defaultTemplate="new_lead_qualification"
              />
            </div>
          }
        />
      ) : (
        <JourneysTable journeys={journeys} />
      )}
    </>
  );
}
