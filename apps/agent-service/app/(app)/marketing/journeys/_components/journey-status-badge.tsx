import { JOURNEY_STATUS_LABELS, type JourneyStatus } from "@/lib/journeys/journey-types";
import shell from "@/components/shell/shell.module.css";
import styles from "./journeys.module.css";

const STATUS_CLASS: Record<JourneyStatus, string> = {
  draft: styles.badgeDraft,
  active: styles.badgeJourneyActive,
  paused: styles.badgeJourneyPaused,
};

export function JourneyStatusBadge({ status }: { status: JourneyStatus }) {
  return (
    <span className={`${shell.badge} ${STATUS_CLASS[status]}`}>{JOURNEY_STATUS_LABELS[status]}</span>
  );
}
