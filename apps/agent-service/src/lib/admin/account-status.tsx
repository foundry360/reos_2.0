import styles from "@/components/shell/shell.module.css";

export const TENANT_STATUS_OPTIONS = [
  { value: "company_info", label: "Company Setup" },
  { value: "billing", label: "Billing" },
  { value: "agents", label: "Agents" },
  { value: "connected_accounts", label: "Connected Accounts" },
  { value: "testing", label: "Testing" },
  { value: "active", label: "Active" },
  { value: "paused", label: "Paused" },
] as const;

export type TenantStatus = (typeof TENANT_STATUS_OPTIONS)[number]["value"];

export const ONBOARDING_STATUSES = [
  "company_info",
  "billing",
  "agents",
  "connected_accounts",
  "testing",
] as const satisfies readonly TenantStatus[];

export type OnboardingStatus = (typeof ONBOARDING_STATUSES)[number];

export const ONBOARDING_STATUS_OPTIONS = TENANT_STATUS_OPTIONS.filter((option) =>
  ONBOARDING_STATUSES.includes(option.value as OnboardingStatus),
);

export const TENANT_STATUS_VALUES = TENANT_STATUS_OPTIONS.map((option) => option.value);

export function isValidTenantStatus(status: string): status is TenantStatus {
  return TENANT_STATUS_VALUES.includes(status as TenantStatus);
}

export function normalizeTenantStatus(status: string): TenantStatus {
  if (status === "pending") return "company_info";
  if (isValidTenantStatus(status)) return status;
  return "company_info";
}

export function isTenantActive(status: string): boolean {
  return status === "active";
}

export function isTenantPaused(status: string): boolean {
  return status === "paused";
}

export function formatTenantStatusLabel(status: string): string {
  const match = TENANT_STATUS_OPTIONS.find((option) => option.value === status);
  if (match) return match.label;
  if (status === "pending") return "Company Setup";
  return status
    .split("_")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

const STATUS_BADGE_CLASS: Record<TenantStatus, string> = {
  company_info: styles.badgeCompanyInfo,
  billing: styles.badgeBilling,
  agents: styles.badgeAgents,
  connected_accounts: styles.badgeConnectedAccounts,
  testing: styles.badgeTesting,
  active: styles.badgeActive,
  paused: styles.badgePaused,
};

const STATUS_FUNNEL_FILL_CLASS: Record<TenantStatus, string> = {
  company_info: styles.dashFunnelFillCompanyInfo,
  billing: styles.dashFunnelFillBilling,
  agents: styles.dashFunnelFillAgents,
  connected_accounts: styles.dashFunnelFillConnectedAccounts,
  testing: styles.dashFunnelFillTesting,
  active: styles.dashFunnelFillActive,
  paused: styles.dashFunnelFillPaused,
};

const STATUS_FUNNEL_LABEL_CLASS: Record<TenantStatus, string> = {
  company_info: styles.dashFunnelLabelCompanyInfo,
  billing: styles.dashFunnelLabelBilling,
  agents: styles.dashFunnelLabelAgents,
  connected_accounts: styles.dashFunnelLabelConnectedAccounts,
  testing: styles.dashFunnelLabelTesting,
  active: styles.dashFunnelLabelActive,
  paused: styles.dashFunnelLabelPaused,
};

const STATUS_CHEVRON_CLASS: Record<TenantStatus, string> = {
  company_info: styles.setupChevronStepCompanyInfo,
  billing: styles.setupChevronStepBilling,
  agents: styles.setupChevronStepAgents,
  connected_accounts: styles.setupChevronStepConnectedAccounts,
  testing: styles.setupChevronStepTesting,
  active: styles.setupChevronStepActive,
  paused: styles.setupChevronStepPaused,
};

export function tenantStatusFunnelFillClass(status: string): string {
  return STATUS_FUNNEL_FILL_CLASS[normalizeTenantStatus(status)];
}

export function tenantStatusFunnelLabelClass(status: string): string {
  return STATUS_FUNNEL_LABEL_CLASS[normalizeTenantStatus(status)];
}

export function tenantStatusChevronClass(status: string): string {
  return STATUS_CHEVRON_CLASS[normalizeTenantStatus(status)];
}

export function tenantStatusBadgeClass(status: string): string {
  return STATUS_BADGE_CLASS[normalizeTenantStatus(status)];
}

function StatusBadgeIcon({ status }: { status: TenantStatus }) {
  if (status === "active") {
    return (
      <svg className={styles.badgeIcon} viewBox="0 0 16 16" fill="none" aria-hidden="true">
        <path
          d="M13.5 4.5L6.5 11.5L3 8"
          stroke="currentColor"
          strokeWidth="1.75"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    );
  }

  if (status === "paused") {
    return (
      <svg className={styles.badgeIcon} viewBox="0 0 16 16" fill="none" aria-hidden="true">
        <path
          d="M5.5 4.5v7M10.5 4.5v7"
          stroke="currentColor"
          strokeWidth="1.75"
          strokeLinecap="round"
        />
      </svg>
    );
  }

  return (
    <svg className={styles.badgeIcon} viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <circle cx="8" cy="8" r="6" stroke="currentColor" strokeWidth="1.5" />
      <path
        d="M8 4.5V8l2.25 2.25"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
      />
    </svg>
  );
}

export function AccountStatusBadge({ status }: { status: string }) {
  const normalized = normalizeTenantStatus(status);

  return (
    <span className={`${styles.badge} ${STATUS_BADGE_CLASS[normalized]}`}>
      <StatusBadgeIcon status={normalized} />
      {formatTenantStatusLabel(status)}
    </span>
  );
}
