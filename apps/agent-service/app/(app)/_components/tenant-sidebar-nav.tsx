"use client";

import { Suspense, useState } from "react";
import { usePathname } from "next/navigation";
import {
  IconCalendar,
  IconData,
  IconHome,
  IconLeads,
  IconPipeline,
  IconReports,
  IconSettings,
  IconTasks,
  IconUsers,
  SidebarNav,
} from "@/components/shell/sidebar-nav";
import { DataImportModal } from "./data-import-modal";
import { PeopleSubnav } from "../leads/_components/leads-subnav";

const TENANT_NAV = [
  { href: "/", label: "Overview", icon: <IconHome />, match: "exact" as const },
  { href: "/leads", label: "Leads", icon: <IconLeads /> },
  { href: "/contacts", label: "Contacts", icon: <IconUsers /> },
  { href: "/opportunities", label: "Opportunities", icon: <IconPipeline /> },
  { href: "/tasks", label: "Tasks", icon: <IconTasks /> },
  { href: "/calendar", label: "Calendar", icon: <IconCalendar /> },
  { href: "/reports", label: "Reports", icon: <IconReports /> },
];

export function TenantSidebarNav() {
  const [importOpen, setImportOpen] = useState(false);

  return (
    <>
      <SidebarNav
        sectionLabel="General"
        items={TENANT_NAV}
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

export function TenantSecondarySidebar() {
  const pathname = usePathname();
  const onLeads = pathname === "/leads" || pathname.startsWith("/leads/");
  const onContacts = pathname === "/contacts" || pathname.startsWith("/contacts/");

  if (onLeads) {
    return (
      <Suspense fallback={null}>
        <PeopleSubnav kind="lead" />
      </Suspense>
    );
  }

  if (onContacts) {
    return (
      <Suspense fallback={null}>
        <PeopleSubnav kind="contact" />
      </Suspense>
    );
  }

  return null;
}
