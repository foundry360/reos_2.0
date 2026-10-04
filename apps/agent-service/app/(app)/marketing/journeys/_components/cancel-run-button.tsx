"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { cancelJourneyRunAction } from "@/lib/journeys/journey-actions";
import styles from "./journeys.module.css";

export function CancelRunButton({ runId }: { runId: string }) {
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
          if (!window.confirm("Cancel this run? Remaining steps won't execute.")) return;
          startTransition(async () => {
            const result = await cancelJourneyRunAction(runId);
            if (!result.ok) setError(result.error ?? "Could not cancel the run.");
            else router.refresh();
          });
        }}
      >
        {pending ? "Cancelling…" : "Cancel"}
      </button>
      {error ? <span className={styles.runError}> {error}</span> : null}
    </>
  );
}
