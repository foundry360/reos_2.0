import { Suspense } from "react";
import { CreateJourneyModal } from "./_components/create-journey-modal";
import { JourneySortMenu } from "./_components/journey-sort-menu";
import { JourneysList } from "./_components/journeys-list";
import { EmptyState } from "@/components/shell/empty-state";
import { PageHeading } from "@/components/shell/page-heading";
import { IconJourney } from "@/components/shell/sidebar-nav";
import { listJourneys } from "@/lib/journeys/journey-repository";
import { parseJourneySort, sortJourneys } from "@/lib/journeys/journey-sort";
import { resolveCurrentTenant, workspaceUnavailableMessage } from "@/lib/tenant/current-tenant";
import shell from "@/components/shell/shell.module.css";
import styles from "./_components/journeys.module.css";

const SUBTITLE =
  "Journeys let agents and teams automate customer engagement and business processes, from first touch to closing.";

interface PageProps {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

export default async function JourneyBuilderPage({ searchParams }: PageProps) {
  const { tenantId, reason } = await resolveCurrentTenant();
  const sort = parseJourneySort((await searchParams).sort);

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
  const journeys = result.ok ? sortJourneys(result.value, sort) : [];

  return (
    <>
      <div className={shell.pageHeader}>
        {heading}
        {journeys.length > 0 ? (
          <div className={shell.pageHeaderActions}>
            <Suspense fallback={null}>
              <JourneySortMenu sort={sort} />
            </Suspense>
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
        <JourneysList journeys={journeys} />
      )}
    </>
  );
}
