import {
  normalizeTenantStatus,
  type TenantStatus,
} from "@/lib/admin/account-status";
import type { TenantConfig } from "@/lib/admin/tenant-config";
import type { TenantUser } from "@/lib/admin/tenant-users";

export type SetupStepId =
  | "companyInfo"
  | "billing"
  | "agents"
  | "connectedAccounts"
  | "testing"
  | "activate";

export interface SetupStep {
  id: SetupStepId;
  label: string;
  shortLabel: string;
  description: string;
  complete: boolean;
}

export interface SetupChecklist {
  steps: SetupStep[];
  completedCount: number;
  totalCount: number;
  readyToActivate: boolean;
  isActive: boolean;
}

/** Onboarding order — mirrors Details → Status (excluding paused). */
const ONBOARDING_STATUS_ORDER: Exclude<TenantStatus, "paused">[] = [
  "company_info",
  "billing",
  "agents",
  "connected_accounts",
  "testing",
  "active",
];

/** Maps a chevron step to the Details → Status value it should set. */
export const SETUP_STEP_TO_STATUS: Record<
  SetupStepId,
  Exclude<TenantStatus, "paused">
> = {
  companyInfo: "company_info",
  billing: "billing",
  agents: "agents",
  connectedAccounts: "connected_accounts",
  testing: "testing",
  activate: "active",
};

function onboardingIndex(status: string): number {
  const normalized = normalizeTenantStatus(status);
  if (normalized === "paused") return ONBOARDING_STATUS_ORDER.length;
  return ONBOARDING_STATUS_ORDER.indexOf(normalized);
}

/**
 * Chevron progress is driven by Details → Status so the two stay in sync.
 * A step is complete once status has moved past it; Active/Paused complete all steps.
 */
export function buildSetupChecklist(
  tenant: TenantConfig,
  _users: TenantUser[],
): SetupChecklist {
  const status = normalizeTenantStatus(tenant.status);
  const index = onboardingIndex(status);
  const isActive = status === "active";
  const isPaused = status === "paused";

  const isStepComplete = (stepIndex: number) =>
    isActive || isPaused || index > stepIndex;

  const steps: SetupStep[] = [
    {
      id: "companyInfo",
      label: "Company Setup",
      shortLabel: "Company Setup",
      description: "Complete Highlights and Details — profile, owner, and address.",
      complete: isStepComplete(0),
    },
    {
      id: "billing",
      label: "Billing",
      shortLabel: "Billing",
      description: "Add the Stripe customer ID in General Info → Billing.",
      complete: isStepComplete(1),
    },
    {
      id: "agents",
      label: "Agents",
      shortLabel: "Agents",
      description: "Enable Concierge, Intake, and other agents in Connections.",
      complete: isStepComplete(2),
    },
    {
      id: "connectedAccounts",
      label: "Connected Accounts",
      shortLabel: "Connected Accounts",
      description: "Assign the Twilio SMS number and connect social channels.",
      complete: isStepComplete(3),
    },
    {
      id: "testing",
      label: "Testing",
      shortLabel: "Testing",
      description: "Send test messages and confirm agents respond correctly.",
      complete: isStepComplete(4),
    },
    {
      id: "activate",
      label: "Activate",
      shortLabel: "Activate",
      description: "Set status to Active in Details → Account Information.",
      complete: isStepComplete(5),
    },
  ];

  const completedCount = steps.filter((step) => step.complete).length;
  const readyToActivate = status === "testing";

  return {
    steps,
    completedCount,
    totalCount: steps.length,
    readyToActivate,
    isActive,
  };
}
