"use client";

import { useState, useTransition } from "react";
import { createPortal } from "react-dom";
import { useRouter } from "next/navigation";
import { RowActionsMenu } from "@/components/shell/row-actions-menu";
import {
  deleteJourneyAction,
  duplicateJourneyAction,
  setJourneyStatusAction,
} from "@/lib/journeys/journey-actions";
import { nextJourneyStatus, type JourneySummary } from "@/lib/journeys/journey-types";
import shell from "@/components/shell/shell.module.css";

interface JourneyRowActionsProps {
  journey: JourneySummary;
  onError: (message: string | null) => void;
}

export function JourneyRowActions({ journey, onError }: JourneyRowActionsProps) {
  const router = useRouter();
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const lifecycle = nextJourneyStatus(journey.status);

  function run(action: () => Promise<{ ok: boolean; error?: string; id?: string }>, then?: (id?: string) => void) {
    onError(null);
    startTransition(async () => {
      const result = await action();
      if (!result.ok) {
        onError(result.error ?? "Something went wrong.");
        return;
      }
      if (then) then(result.id);
      else router.refresh();
    });
  }

  function handleDelete() {
    setDeleteError(null);
    startTransition(async () => {
      const result = await deleteJourneyAction(journey.id);
      if (!result.ok) {
        setDeleteError(result.error ?? "Could not delete the journey.");
        return;
      }
      setDeleteOpen(false);
      router.refresh();
    });
  }

  return (
    <>
      <RowActionsMenu ariaLabel={`Actions for ${journey.name}`} disabled={pending} estimatedHeight={216}>
        <button
          type="button"
          className={shell.dropdownItem}
          role="menuitem"
          onClick={() => router.push(`/marketing/journeys/${journey.id}`)}
        >
          Open
        </button>
        <button
          type="button"
          className={shell.dropdownItem}
          role="menuitem"
          onClick={() => run(() => duplicateJourneyAction(journey.id))}
        >
          Duplicate
        </button>
        <button
          type="button"
          className={shell.dropdownItem}
          role="menuitem"
          onClick={() =>
            run(() => setJourneyStatusAction({ journeyId: journey.id, status: lifecycle.status }))
          }
        >
          {lifecycle.label}
        </button>
        {journey.status !== "archived" ? (
          <button
            type="button"
            className={shell.dropdownItem}
            role="menuitem"
            onClick={() => {
              if (!window.confirm("Archive this journey? Active runs are cancelled; run history is kept.")) return;
              run(() => setJourneyStatusAction({ journeyId: journey.id, status: "archived" }));
            }}
          >
            Archive
          </button>
        ) : null}
        <button
          type="button"
          className={`${shell.dropdownItem} ${shell.dropdownItemDanger}`}
          role="menuitem"
          onClick={() => {
            setDeleteError(null);
            window.setTimeout(() => setDeleteOpen(true), 0);
          }}
        >
          Delete
        </button>
      </RowActionsMenu>

      {deleteOpen &&
        createPortal(
          <div className={shell.modalOverlay} onClick={() => !pending && setDeleteOpen(false)}>
            <div
              className={shell.modalPanel}
              role="dialog"
              aria-modal="true"
              aria-labelledby="delete-journey-title"
              onClick={(event) => event.stopPropagation()}
            >
              <div className={shell.modalHeader}>
                <div>
                  <h2 id="delete-journey-title" className={shell.modalTitle}>
                    Delete {journey.name}?
                  </h2>
                  <p className={shell.modalSubtitle}>
                    Only journeys that have never run can be deleted. A journey with run history can be
                    archived instead, which keeps its runs.
                  </p>
                </div>
                <button
                  type="button"
                  className={shell.iconBtn}
                  aria-label="Close"
                  onClick={() => setDeleteOpen(false)}
                  disabled={pending}
                >
                  ×
                </button>
              </div>
              <div className={shell.modalBody}>
                {deleteError && <p className={shell.error}>{deleteError}</p>}
                <div className={shell.modalFooter}>
                  <button
                    type="button"
                    className={shell.btnSecondary}
                    onClick={() => setDeleteOpen(false)}
                    disabled={pending}
                  >
                    Cancel
                  </button>
                  <button
                    type="button"
                    className={shell.btnDanger}
                    onClick={handleDelete}
                    disabled={pending}
                  >
                    {pending ? "Deleting…" : "Delete"}
                  </button>
                </div>
              </div>
            </div>
          </div>,
          document.body,
        )}
    </>
  );
}
