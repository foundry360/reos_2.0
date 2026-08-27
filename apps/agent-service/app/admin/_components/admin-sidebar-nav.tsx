"use client";

import { IconBuilding, IconLayoutDashboard, IconUsers, SidebarNav } from "@/components/shell/sidebar-nav";

const ADMIN_NAV = [
  { href: "/admin/dashboard", label: "Dashboard", icon: <IconLayoutDashboard /> },
  { href: "/admin", label: "Accounts", icon: <IconBuilding />, match: "exact" as const },
  { href: "/admin/users", label: "Users", icon: <IconUsers /> },
];

export function AdminSidebarNav() {
  return <SidebarNav sectionLabel="General" items={ADMIN_NAV} />;
}
