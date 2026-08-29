import { Suspense } from "react";
import styles from "@/components/shell/shell.module.css";
import { ShellHeader } from "@/components/shell/shell-header";
import { ShellLayout } from "@/components/shell/shell-layout";
import { ThemeProvider } from "@/components/theme/theme-provider";
import { AdminSidebarNav } from "./admin-sidebar-nav";
import type { UserProfile } from "@/lib/profile/server";
import type { UserNotification } from "@/lib/notifications/types";

interface AdminShellProps {
  email: string;
  profile: UserProfile;
  notifications?: UserNotification[];
  children: React.ReactNode;
}

export function AdminShell({
  email,
  profile,
  notifications = [],
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
          tenantAppHref="/"
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
