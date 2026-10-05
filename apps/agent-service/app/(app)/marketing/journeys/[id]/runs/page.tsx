import Link from "next/link";
import { notFound } from "next/navigation";
import { CancelRunButton } from "../../_components/cancel-run-button";
import { JourneyStatusBadge } from "../../_components/journey-status-badge";
import { RetryRunButton } from "../../_components/retry-run-button";
import { EmptyState } from "@/components/shell/empty-state";
import { PageHeading } from "@/components/shell/page-heading";
import { formatStableDateTime } from "@/components/shell/format-date";
import { IconJourney } from "@/components/shell/sidebar-nav";
import { getJourneyDefinition } from "@/lib/journeys/journey-repository";
import {
  listJourneyRuns,
  listJourneyRunSteps,
  type JourneyRunStatus,
  type JourneyRunStep,
} from "@/lib/journeys/journey-run-repository";
import { TRIGGER_EVENTS, isTriggerEventType } from "@/lib/journeys/runtime/contracts";
import { retryBlockReason } from "@/lib/journeys/runtime/run-retry";
import { resolveCurrentTenant, workspaceUnavailableMessage } from "@/lib/tenant/current-tenant";
import shell from "@/components/shell/shell.module.css";
import styles from "../../_components/journeys.module.css";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const RUN_STATUS: Record<JourneyRunStatus, { label: string; className: string }> = {
  running: { label: "Running", className: shell.badgeActive },
  waiting: { label: "Waiting", className: shell.badgePending },
  paused: { label: "Paused", className: shell.badgePaused },
  completed: { label: "Completed", className: shell.badgeTaskDone },
  failed: { label: "Failed", className: styles.badgeRunFailed },
  cancelled: { label: "Cancelled", className: styles.badgeRunMuted },
};

const STEP_LABEL: Record<JourneyRunStep["status"], string> = {
  pending: "Pending",
  running: "In progress",
  completed: "Done",
  failed: "Failed",
  skipped: "Skipped",
};

function stepDetail(step: JourneyRunStep): string {
  if (step.error) {
    const retry = step.errorKind === "transient" ? ` (attempt ${step.attemptCount}, will retry if attempts remain)` : "";
    return `${step.error}${retry}`;
  }
  const output = step.output;
  if (typeof output.skipped_reason === "string") return output.skipped_reason;
  if (step.nodeType === "condition") return output.result ? "True → Yes path" : "False → No path";
  if (typeof output.resume_at === "string" && step.status === "running") {
    return `Resumes ${formatStableDateTime(output.resume_at)}`;
  }
  const parts = Object.entries(output)
    .filter(([key, value]) => key !== "event" && value !== null && typeof value !== "object")
    .slice(0, 3)
    .map(([key, value]) => `${key.replace(/_/g, " ")}: ${String(value).slice(0, 80)}`);
  return parts.join(" · ");
}

interface PageProps {
  params: Promise<{ id: string }>;
}

export default async function JourneyRunsPage({ params }: PageProps) {
  const { id } = await params;
  if (!UUID_PATTERN.test(id)) notFound();

  const { tenantId, reason } = await resolveCurrentTenant();
  if (!tenantId) {
    return (
      <>
        <div className={shell.pageHeader}>
          <PageHeading icon={<IconJourney />} title="Run history" tone="light" />
        </div>
        <p className={shell.empty}>{workspaceUnavailableMessage(reason)}</p>
      </>
    );
  }

  const journey = await getJourneyDefinition(tenantId, id);
  if (journey.ok && !journey.value) notFound();
  const runs = await listJourneyRuns(tenantId, id);
  const steps = runs.ok ? await listJourneyRunSteps(tenantId, runs.value.map((run) => run.id)) : null;

  const name = journey.ok && journey.value ? journey.value.name : "Journey";

  return (
    <>
      <div className={shell.pageHeader}>
        <div>
          <Link href={`/marketing/journeys/${id}`} className={styles.runsBack}>
            ← Back to builder
          </Link>
          <PageHeading
            icon={<IconJourney />}
            title={`${name}: run history`}
            subtitle={
              journey.ok && journey.value
                ? `Version ${journey.value.version}. Each run follows the version that was live when it started.`
                : undefined
            }
            tone="light"
          />
        </div>
        {journey.ok && journey.value ? (
          <div className={shell.pageHeaderActions}>
            <JourneyStatusBadge status={journey.value.status} />
          </div>
        ) : null}
      </div>

      {!runs.ok ? (
        <p className={shell.error}>{runs.error}</p>
      ) : runs.value.length === 0 ? (
        <EmptyState
          title="No runs yet"
          description="When this journey is active and its trigger event happens, each lead it runs for appears here with every step it took."
        />
      ) : (
        <div className={shell.tableWrap}>
          <table className={shell.table}>
            <thead>
              <tr>
                <th>Started</th>
                <th>Lead</th>
                <th>Status</th>
                <th>Steps</th>
                <th aria-label="Actions" />
              </tr>
            </thead>
            <tbody>
              {runs.value.map((run) => {
                const status = RUN_STATUS[run.status] ?? RUN_STATUS.running;
                const runSteps = steps?.ok ? (steps.value.get(run.id) ?? []) : [];
                const canRetry =
                  journey.ok &&
                  journey.value !== null &&
                  steps?.ok === true &&
                  retryBlockReason(run, runSteps.at(-1) ?? null, journey.value.status) === null;
                const trigger = isTriggerEventType(run.triggerEvent)
                  ? TRIGGER_EVENTS[run.triggerEvent].label
                  : run.triggerEvent;
                return (
                  <tr key={run.id}>
                    <td className={styles.journeyMuted}>
                      {formatStableDateTime(run.startedAt)}
                      <br />
                      <small>
                        {trigger} · v{run.journeyVersion}
                      </small>
                    </td>
                    <td>
                      {run.contactId ? (
                        <Link href={`/leads/${run.contactId}`}>{run.contactName ?? "Unnamed lead"}</Link>
                      ) : (
                        <span className={styles.journeyMuted}>Deleted lead</span>
                      )}
                    </td>
                    <td>
                      <span className={`${shell.badge} ${status.className}`}>{status.label}</span>
                      {run.status === "waiting" && run.resumeAt ? (
                        <div className={styles.journeyMuted}>
                          <small>Resumes {formatStableDateTime(run.resumeAt)}</small>
                        </div>
                      ) : null}
                      {run.error && run.status !== "completed" ? (
                        <div className={styles.runError}>{run.error}</div>
                      ) : null}
                    </td>
                    <td>
                      <details>
                        <summary>{runSteps.length} step{runSteps.length === 1 ? "" : "s"}</summary>
                        <ol className={styles.runSteps}>
                          {runSteps.map((step) => (
                            <li key={step.id} className={styles.runStep}>
                              <span>{STEP_LABEL[step.status]}</span>
                              <span>
                                <strong>{step.nodeName || step.nodeType}</strong>
                                {stepDetail(step) ? (
                                  <span className={styles.runStepDetail}> {stepDetail(step)}</span>
                                ) : null}
                              </span>
                            </li>
                          ))}
                        </ol>
                      </details>
                    </td>
                    <td className={styles.journeyActionsCell}>
                      {["running", "waiting", "paused"].includes(run.status) ? (
                        <CancelRunButton runId={run.id} />
                      ) : null}
                      {canRetry ? <RetryRunButton runId={run.id} version={run.journeyVersion} /> : null}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}
