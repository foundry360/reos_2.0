"use client";

import {
  IconBuilding,
  IconCreditCard,
  IconIntegrations,
  IconLayoutDashboard,
  IconReports,
  IconSettings,
  IconUsers,
  SidebarNav,
} from "@/components/shell/sidebar-nav";

const ADMIN_NAV = [
  { href: "/admin/dashboard", label: "Dashboard", icon: <IconLayoutDashboard /> },
  { href: "/admin", label: "Accounts", icon: <IconBuilding />, match: "exact" as const },
  { href: "/admin/billing", label: "Billing", icon: <IconCreditCard /> },
  { href: "/admin/reports", label: "Reporting", icon: <IconReports /> },
  { href: "/admin/users", label: "Users", icon: <IconUsers /> },
];

const ADMIN_SECONDARY_NAV = [
  { href: "/admin/integrations", label: "Integrations", icon: <IconIntegrations /> },
  { href: "/admin/settings", label: "Settings", icon: <IconSettings /> },
];

export function AdminSidebarNav() {
  return (
    <SidebarNav
      sectionLabel="Workspace"
      items={ADMIN_NAV}
      secondaryItems={ADMIN_SECONDARY_NAV}
    />
  );
}
