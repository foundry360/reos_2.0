"use client";

import { Fragment, useState, useTransition, type MouseEvent } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { RelativeTime, formatStableDate } from "@/components/shell/relative-time";
import { setJourneyStatusAction } from "@/lib/journeys/journey-actions";
import { JOURNEY_STATUS_LABELS, type JourneySummary } from "@/lib/journeys/journey-types";
import { UserAvatar } from "@/components/shell/user-avatar";
import { JourneyNodeGlyph, NODE_TYPE_CLASS } from "./journey-node-icon";
import { JourneyRowActions } from "./journey-row-actions";
import shell from "@/components/shell/shell.module.css";
import styles from "./journeys.module.css";

const PREVIEW_STEPS = 5;

function StepStrip({ journey }: { journey: JourneySummary }) {
  const shown = journey.nodeTypes.slice(0, PREVIEW_STEPS);
  const hidden = journey.nodeTypes.length - shown.length;

  if (shown.length === 0) {
    return (
      <div className={styles.journeyStrip} aria-hidden>
        <span className={`${styles.journeyStripTile} ${styles.journeyStripEmpty}`} />
      </div>
    );
  }

  return (
    <div className={styles.journeyStrip} aria-hidden>
      {shown.map((type, index) => (
        <Fragment key={index}>
          {index > 0 ? <span className={styles.journeyStripLink} /> : null}
          <span
            className={`${styles.journeyStripTile} ${type === "condition" ? styles.journeyStripDiamond : ""} ${NODE_TYPE_CLASS[type]}`}
          >
            <span className={styles.journeyStripGlyph}>
              <JourneyNodeGlyph type={type} size={13} />
            </span>
          </span>
        </Fragment>
      ))}
      {hidden > 0 ? <span className={styles.journeyStripMore}>+{hidden}</span> : null}
    </div>
  );
}

function LiveSwitch({ journey, onError }: { journey: JourneySummary; onError: (message: string | null) => void }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const on = journey.status === "active";
  const archived = journey.status === "archived";

  function toggle() {
    onError(null);
    startTransition(async () => {
      const result = await setJourneyStatusAction({ journeyId: journey.id, status: on ? "paused" : "active" });
      if (!result.ok) {
        onError(result.error ?? "Could not change the journey's status.");
        return;
      }
      router.refresh();
    });
  }

  return (
    <label className={styles.journeyLive}>
      <span className={styles.journeyLiveLabel}>{on ? "Live" : "Off"}</span>
      <button
        type="button"
        role="switch"
        aria-checked={on}
        aria-label={on ? `Pause ${journey.name}` : `Activate ${journey.name}`}
        title={archived ? "Archived journeys can't be activated" : undefined}
        className={`${shell.toggleSwitch} ${styles.journeyToggle} ${on ? shell.toggleSwitchOn : ""}`}
        disabled={pending || archived}
        onClick={toggle}
      >
        <span className={`${shell.toggleSwitchThumb} ${styles.journeyToggleThumb}`} aria-hidden />
      </button>
    </label>
  );
}

export function JourneysList({ journeys }: { journeys: JourneySummary[] }) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);

  function open(event: MouseEvent<HTMLElement>, id: string) {
    const target = event.target as HTMLElement | null;
    if (target?.closest("a, button, label, [role='menu']")) return;
    router.push(`/marketing/journeys/${id}`);
  }

  return (
    <>
      {error ? <p className={shell.error}>{error}</p> : null}
      <ul className={styles.journeyList}>
        {journeys.map((journey) => (
          <li
            key={journey.id}
            className={styles.journeyCard}
            onClick={(event) => open(event, journey.id)}
          >
            <div className={styles.journeyCardBody}>
              <div className={styles.journeyCardTitleRow}>
                <Link
                  href={`/marketing/journeys/${journey.id}`}
                  className={styles.journeyNameLink}
                  title={JOURNEY_STATUS_LABELS[journey.status]}
                >
                  {journey.name}
                </Link>
              </div>
              <div className={styles.journeyMeta}>
                {journey.createdByName ? (
                  <span className={styles.journeyOwner} title={`Created by ${journey.createdByName}`}>
                    <UserAvatar
                      email=""
                      displayName={journey.createdByName}
                      avatarUrl={journey.createdByAvatarUrl}
                      className={styles.journeyOwnerAvatar}
                    />
                    {journey.createdByName}
                  </span>
                ) : null}
                <span className={styles.journeyMetaDate}>
                  Created
                  <svg
                    width="13"
                    height="13"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    aria-hidden
                  >
                    <rect x="3" y="5" width="18" height="16" rx="2" />
                    <path d="M16 3v4M8 3v4M3 10h18" />
                  </svg>
                  {formatStableDate(journey.createdAt)}
                </span>
                <span className={styles.journeyMetaDate}>
                  Updated
                  <svg
                    width="13"
                    height="13"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    aria-hidden
                  >
                    <path d="M3 12a9 9 0 1 0 3-6.7L3 8" />
                    <path d="M3 3v5h5" />
                    <path d="M12 7v5l3 2" />
                  </svg>
                  <RelativeTime iso={journey.updatedAt} />
                </span>
              </div>
            </div>

            <div className={styles.journeyCardFlow}>
              <StepStrip journey={journey} />
            </div>

            <div className={styles.journeyCardActions}>
              <Link
                href={`/marketing/journeys/${journey.id}/runs`}
                className={styles.journeyRunsChip}
                title="Run history"
              >
                <strong>{journey.runCount}</strong> {journey.runCount === 1 ? "run" : "runs"}
              </Link>
              <LiveSwitch journey={journey} onError={setError} />
              <JourneyRowActions journey={journey} onError={setError} />
            </div>
          </li>
        ))}
      </ul>
    </>
  );
}
