"use client";

import {
  IconHome,
  IconInbox,
  IconPipeline,
  SidebarNav,
} from "@/components/shell/sidebar-nav";

export function TenantSidebarNav() {
  const workspaceItems = [
    { href: "/", label: "Home", icon: <IconHome />, match: "exact" as const },
    { href: "/inbox", label: "Inbox", icon: <IconInbox /> },
    { href: "/pipeline", label: "Pipeline", icon: <IconPipeline /> },
  ];

  return <SidebarNav sectionLabel="General" items={workspaceItems} />;
}
