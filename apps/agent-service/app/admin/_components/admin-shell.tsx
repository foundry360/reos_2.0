import { Suspense } from "react";
import styles from "@/components/shell/shell.module.css";
import { ShellHeader } from "@/components/shell/shell-header";
import { ShellLayout } from "@/components/shell/shell-layout";
import { ThemeProvider } from "@/components/theme/theme-provider";
import { AdminSidebarNav } from "./admin-sidebar-nav";
import type { UserProfile } from "@/lib/profile/server";
import type { UserNotification } from "@/lib/notifications/types";
import type { AssignedTenant } from "@/lib/tenant/current-tenant";

interface AdminShellProps {
  email: string;
  profile: UserProfile;
  notifications?: UserNotification[];
  assignedTenants?: AssignedTenant[];
  children: React.ReactNode;
}

export function AdminShell({
  email,
  profile,
  notifications = [],
  assignedTenants = [],
  children,
}: AdminShellProps) {
  return (
    <ThemeProvider preference={profile.themePreference}>
      <div className={styles.admin}>
        <ShellHeader
          logoHref="/admin"
          logoSub="Admin"
          email={email}
          profile={profile}
          accountHref="/admin/settings"
          tenantWorkspaces={assignedTenants}
          notifications={notifications}
        />
        <ShellLayout
          sidebar={
            <Suspense fallback={null}>
              <AdminSidebarNav />
            </Suspense>
          }
        >
          {children}
        </ShellLayout>
      </div>
    </ThemeProvider>
  );
}
