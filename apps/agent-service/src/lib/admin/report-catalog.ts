export type ReportIconTone = "blue" | "green" | "purple" | "amber";

export interface CannedReport {
  slug: string;
  title: string;
  description: string;
  category: "Usage" | "Accounts" | "Billing" | "Operations";
  iconTone: ReportIconTone;
}

export const CANNED_REPORTS: CannedReport[] = [
  {
    slug: "usage-by-tenant",
    title: "Usage by tenant",
    description: "Cycle usage totals and Twilio, AI, and other costs grouped by account.",
    category: "Usage",
    iconTone: "blue",
  },
  {
    slug: "onboarding-funnel",
    title: "Onboarding funnel",
    description: "Accounts by setup stage with counts across the onboarding pipeline.",
    category: "Accounts",
    iconTone: "green",
  },
  {
    slug: "billing-readiness",
    title: "Billing readiness",
    description: "Which accounts have billing configured and which still need setup.",
    category: "Billing",
    iconTone: "amber",
  },
  {
    slug: "account-status",
    title: "Account status",
    description: "Fleet breakdown of active, onboarding, and paused tenants.",
    category: "Accounts",
    iconTone: "purple",
  },
  {
    slug: "message-activity",
    title: "Message activity",
    description: "Inbound and outbound SMS volume by tenant over a selected period.",
    category: "Operations",
    iconTone: "blue",
  },
  {
    slug: "attention-queue",
    title: "Attention queue",
    description: "Accounts stuck in onboarding, missing phone, or ready to activate.",
    category: "Operations",
    iconTone: "amber",
  },
];

export function getCannedReport(slug: string): CannedReport | undefined {
  return CANNED_REPORTS.find((report) => report.slug === slug);
}
