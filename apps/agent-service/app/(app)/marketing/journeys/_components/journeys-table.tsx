"use client";

import { useState, type MouseEvent } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { RelativeTime, formatStableDate } from "@/components/shell/relative-time";
import type { JourneySummary } from "@/lib/journeys/journey-types";
import { JourneyRowActions } from "./journey-row-actions";
import { JourneyStatusBadge } from "./journey-status-badge";
import shell from "@/components/shell/shell.module.css";
import styles from "./journeys.module.css";

export function JourneysTable({ journeys }: { journeys: JourneySummary[] }) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);

  function onRowClick(event: MouseEvent<HTMLTableRowElement>, id: string) {
    const target = event.target as HTMLElement | null;
    if (target?.closest("a, button, [role='menu']")) return;
    router.push(`/marketing/journeys/${id}`);
  }

  return (
    <>
      {error ? <p className={shell.error}>{error}</p> : null}
      <div className={shell.tableWrap}>
        <table className={shell.table}>
          <thead>
            <tr>
              <th>Journey</th>
              <th>Status</th>
              <th className={styles.journeyHideSm}>Nodes</th>
              <th>Last updated</th>
              <th className={styles.journeyHideSm}>Created</th>
              <th className={styles.journeyActionsCell}>
                <span className={shell.srOnly}>Actions</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {journeys.map((journey) => (
              <tr
                key={journey.id}
                className={styles.journeyRow}
                onClick={(event) => onRowClick(event, journey.id)}
              >
                <td>
                  <div className={styles.journeyNameCell}>
                    <Link href={`/marketing/journeys/${journey.id}`} className={styles.journeyNameLink}>
                      {journey.name}
                    </Link>
                    <p className={styles.journeyDescription}>
                      {journey.description || "No description"}
                    </p>
                  </div>
                </td>
                <td>
                  <JourneyStatusBadge status={journey.status} />
                </td>
                <td className={`${styles.journeyMuted} ${styles.journeyHideSm}`}>
                  {journey.nodeCount}
                </td>
                <td className={styles.journeyMuted}>
                  <RelativeTime iso={journey.updatedAt} />
                </td>
                <td className={`${styles.journeyMuted} ${styles.journeyHideSm}`}>
                  {formatStableDate(journey.createdAt)}
                </td>
                <td className={styles.journeyActionsCell}>
                  <JourneyRowActions journey={journey} onError={setError} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}
