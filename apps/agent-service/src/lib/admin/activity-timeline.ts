import { formatPhoneDisplay } from "@/lib/phone-display";
import { formatTenantStatusLabel } from "@/lib/admin/account-status";
import type { TenantConfig } from "@/lib/admin/tenant-config";

export type ActivityTimelineTone = "purple" | "green" | "cyan" | "blue";

export type ActivityTimelineIcon =
  | "created"
  | "updated"
  | "activated"
  | "phone"
  | "stripe"
  | "channel"
  | "users";

export interface ActivityTimelineEntry {
  id: string;
  title: string;
  description?: string;
  occurredAt: string;
  tone: ActivityTimelineTone;
  icon: ActivityTimelineIcon;
}

export const ACTIVITY_TIMELINE_LIMIT = 6;

export function formatRelativeTime(iso: string): string {
  const diffMs = Date.now() - new Date(iso).getTime();
  const minutes = Math.max(1, Math.floor(diffMs / 60_000));

  if (minutes < 60) return `${minutes} min ago`;

  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} hr ago`;

  const days = Math.floor(hours / 24);
  if (days === 1) return "1 day ago";
  if (days < 7) return `${days} days ago`;

  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  }).format(new Date(iso));
}

export function buildActivityTimeline(
  tenant: TenantConfig,
  userCount: number,
): ActivityTimelineEntry[] {
  const entries: ActivityTimelineEntry[] = [
    {
      id: "created",
      title: "Account created",
      description: tenant.createdByLabel
        ? `Created by ${tenant.createdByLabel}`
        : "Account added to REOS",
      occurredAt: tenant.createdAt,
      tone: "cyan",
      icon: "created",
    },
  ];

  if (tenant.updatedAt !== tenant.createdAt) {
    entries.push({
      id: "updated",
      title: "Account updated",
      description: tenant.lastModifiedByLabel
        ? `Last change by ${tenant.lastModifiedByLabel}`
        : "Account details were changed",
      occurredAt: tenant.updatedAt,
      tone: "purple",
      icon: "updated",
    });
  }

  if (tenant.status === "active") {
    entries.push({
      id: "activated",
      title: "Account activated",
      description: `Status set to ${formatTenantStatusLabel(tenant.status)}`,
      occurredAt: tenant.updatedAt,
      tone: "green",
      icon: "activated",
    });
  }

  if (tenant.primaryPhone) {
    entries.push({
      id: "phone",
      title: "Phone number assigned",
      description: formatPhoneDisplay(tenant.primaryPhone) ?? tenant.primaryPhone,
      occurredAt: tenant.updatedAt,
      tone: "blue",
      icon: "phone",
    });
  }

  if (tenant.stripeCustomerId) {
    entries.push({
      id: "stripe",
      title: "Stripe customer linked",
      description: tenant.stripeCustomerId,
      occurredAt: tenant.updatedAt,
      tone: "purple",
      icon: "stripe",
    });
  }

  for (const channel of tenant.channelAccounts) {
    if (channel.status !== "connected") continue;

    const label = channel.channel === "messenger" ? "Facebook Messenger" : "Instagram";
    entries.push({
      id: `channel-${channel.channel}`,
      title: `${label} connected`,
      description: channel.accountLabel ?? "Social channel connected",
      occurredAt: tenant.updatedAt,
      tone: "green",
      icon: "channel",
    });
  }

  if (userCount > 0) {
    entries.push({
      id: "users",
      title: userCount === 1 ? "1 user on account" : `${userCount} users on account`,
      description: "Team members invited or added",
      occurredAt: tenant.updatedAt,
      tone: "cyan",
      icon: "users",
    });
  }

  return entries
    .sort((a, b) => new Date(b.occurredAt).getTime() - new Date(a.occurredAt).getTime())
    .slice(0, ACTIVITY_TIMELINE_LIMIT);
}
