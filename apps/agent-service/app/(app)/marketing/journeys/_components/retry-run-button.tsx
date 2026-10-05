"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { retryJourneyRunAction } from "@/lib/journeys/journey-actions";
import styles from "./journeys.module.css";

export function RetryRunButton({ runId, version }: { runId: string; version: number }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  return (
    <>
      <button
        type="button"
        className={styles.configLink}
        disabled={pending}
        onClick={() => {
          const message = `Retry the failed step and continue? Earlier steps won't run again. The run stays on version ${version}.`;
          if (!window.confirm(message)) return;
          startTransition(async () => {
            const result = await retryJourneyRunAction(runId);
            if (!result.ok) setError(result.error ?? "Could not retry the run.");
            else router.refresh();
          });
        }}
      >
        {pending ? "Retrying…" : "Retry"}
      </button>
      {error ? <span className={styles.runError}> {error}</span> : null}
    </>
  );
}
