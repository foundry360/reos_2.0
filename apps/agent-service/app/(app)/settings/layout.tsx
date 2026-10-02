import type { ReactNode } from "react";
import { PageHeading } from "@/components/shell/page-heading";
import { IconSettings } from "@/components/shell/sidebar-nav";
import { getWorkspaceAccess } from "@/lib/tenant/workspace-access";
import { SettingsTabs } from "./_components/settings-tabs";
import styles from "@/components/shell/shell.module.css";

export default async function SettingsLayout({ children }: { children: ReactNode }) {
  const access = await getWorkspaceAccess();
  const tabs = [
    { href: "/settings", label: "Personal" },
    ...(access?.canManageChannels ? [{ href: "/settings/channels", label: "Channels" }] : []),
  ];

  return (
    <>
      <div className={styles.pageHeader}>
        <PageHeading
          icon={<IconSettings />}
          title="Settings"
          subtitle={
            access?.canManageChannels
              ? "Manage your account, notifications, and workspace channels."
              : "Manage your account, appearance, and notifications."
          }
          tone="dark"
        />
      </div>
      {tabs.length > 1 ? <SettingsTabs tabs={tabs} /> : null}
      {children}
    </>
  );
}
