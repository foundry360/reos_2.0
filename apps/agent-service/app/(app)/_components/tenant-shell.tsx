import { Suspense } from "react";
import styles from "@/components/shell/shell.module.css";
import { ShellHeader } from "@/components/shell/shell-header";
import { ShellLayout } from "@/components/shell/shell-layout";
import { ThemeProvider } from "@/components/theme/theme-provider";
import { TenantSidebarNav } from "./tenant-sidebar-nav";
import type { UserProfile } from "@/lib/profile/server";
import type { UserNotification } from "@/lib/notifications/types";

interface TenantShellProps {
  email: string;
  profile: UserProfile;
  showAdminLink: boolean;
  notifications?: UserNotification[];
  impersonateBanner?: React.ReactNode;
  children: React.ReactNode;
}

export function TenantShell({
  email,
  profile,
  showAdminLink,
  notifications = [],
  impersonateBanner,
  children,
}: TenantShellProps) {
  return (
    <ThemeProvider preference={profile.themePreference}>
      <div className={styles.admin}>
        {impersonateBanner}
        <ShellHeader
          logoHref="/"
          email={email}
          profile={profile}
          adminLink={showAdminLink}
          showGlobalSearch
          notifications={notifications}
        />
        <ShellLayout
          sidebar={
            <Suspense fallback={null}>
              <TenantSidebarNav />
            </Suspense>
          }
        >
          {children}
        </ShellLayout>
      </div>
    </ThemeProvider>
  );
}
