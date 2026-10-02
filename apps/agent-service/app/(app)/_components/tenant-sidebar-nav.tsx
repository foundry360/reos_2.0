"use client";

import { useState } from "react";
import {
  IconCalendar,
  IconData,
  IconHome,
  IconLeads,
  IconJourney,
  IconOpportunities,
  IconReports,
  IconSettings,
  IconTasks,
  IconUsers,
  SidebarNav,
} from "@/components/shell/sidebar-nav";
import { DataImportModal } from "./data-import-modal";

const TENANT_NAV = [
  { href: "/overview", label: "Overview", icon: <IconHome />, match: "exact" as const },
  { href: "/leads", label: "Leads", icon: <IconLeads /> },
  { href: "/contacts", label: "Clients", icon: <IconUsers /> },
  { href: "/opportunities", label: "Opportunities", icon: <IconOpportunities /> },
  { href: "/tasks", label: "Tasks", icon: <IconTasks /> },
  { href: "/calendar", label: "Calendar", icon: <IconCalendar /> },
  { href: "/reports", label: "Reports", icon: <IconReports /> },
];

const TENANT_NAV_SECTIONS = [
  {
    label: "Marketing",
    items: [{ href: "/marketing/journeys", label: "Journey Builder", icon: <IconJourney /> }],
  },
];

export function TenantSidebarNav() {
  const [importOpen, setImportOpen] = useState(false);

  return (
    <>
      <SidebarNav
        sectionLabel="Workspace"
        items={TENANT_NAV}
        sections={TENANT_NAV_SECTIONS}
        secondaryItems={[
          {
            id: "data-import",
            label: "Data",
            icon: <IconData />,
            onClick: () => setImportOpen(true),
            active: importOpen,
          },
          { href: "/settings", label: "Settings", icon: <IconSettings /> },
        ]}
      />
      <DataImportModal open={importOpen} onClose={() => setImportOpen(false)} />
    </>
  );
}
