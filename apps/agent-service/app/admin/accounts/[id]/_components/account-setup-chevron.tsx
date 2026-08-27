"use client";

import { useTransition } from "react";
import { useRouter } from "next/navigation";
import { setTenantStatusFromStepAction } from "@/lib/admin/account-actions";
import { normalizeTenantStatus, tenantStatusChevronClass } from "@/lib/admin/account-status";
import {
  SETUP_STEP_TO_STATUS,
  type SetupChecklist,
  type SetupStep,
  type SetupStepId,
} from "@/lib/admin/setup-checklist";
import styles from "@/components/shell/shell.module.css";

interface AccountSetupChevronProps {
  tenantId: string;
  currentStatus: string;
  checklist: SetupChecklist;
}

type StepState = "complete" | "current" | "pending";

const STEP_STATE_CLASS: Record<StepState, string> = {
  complete: styles.setupChevronStepComplete,
  current: styles.setupChevronStepCurrent,
  pending: styles.setupChevronStepPending,
};

function resolveStepState(step: SetupStep, index: number, steps: SetupStep[]): StepState {
  if (step.complete) return "complete";
  const firstIncomplete = steps.findIndex((entry) => !entry.complete);
  return index === firstIncomplete ? "current" : "pending";
}

export function AccountSetupChevron({
  tenantId,
  currentStatus,
  checklist,
}: AccountSetupChevronProps) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const normalizedStatus = normalizeTenantStatus(currentStatus);

  function handleStepClick(stepId: SetupStepId) {
    const nextStatus = SETUP_STEP_TO_STATUS[stepId];
    if (!nextStatus || nextStatus === normalizedStatus) return;

    startTransition(async () => {
      const result = await setTenantStatusFromStepAction(tenantId, nextStatus);
      if (!result.ok) {
        console.error(result.error ?? "Could not update status.");
        return;
      }
      router.refresh();
    });
  }

  return (
    <section className={styles.setupChevronCard}>
      <h2 className={styles.setupChevronTitle}>Onboarding Progress</h2>

      <ol
        className={styles.setupChevronTrack}
        aria-label="Onboarding progress"
        data-busy={pending ? "true" : undefined}
      >
        {checklist.steps.map((step, index) => {
          const state = resolveStepState(step, index, checklist.steps);
          const stepStatus = SETUP_STEP_TO_STATUS[step.id];
          const isSelected = stepStatus === normalizedStatus;

          return (
            <li
              key={step.id}
              className={`${styles.setupChevronStep} ${tenantStatusChevronClass(stepStatus)} ${STEP_STATE_CLASS[state]}`}
            >
              <button
                type="button"
                className={styles.setupChevronBtn}
                title={step.description}
                aria-label={`Set status to ${step.label}`}
                aria-current={isSelected ? "step" : undefined}
                disabled={pending}
                onClick={() => handleStepClick(step.id)}
              >
                {step.shortLabel}
              </button>
            </li>
          );
        })}
      </ol>
    </section>
  );
}
