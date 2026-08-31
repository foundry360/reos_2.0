import Link from "next/link";
import styles from "./shell.module.css";
import { GlobalSearch } from "./global-search";
import { NotificationsMenu } from "./notifications-menu";
import { UserMenu } from "./user-menu";
import type { UserProfile } from "@/lib/profile/server";
import type { UserNotification } from "@/lib/notifications/types";

interface ShellHeaderProps {
  logoHref: string;
  logoSub?: string;
  email: string;
  profile: UserProfile;
  accountHref?: string;
  tenantAppHref?: string;
  adminLink?: boolean;
  showGlobalSearch?: boolean;
  notifications?: UserNotification[];
}

export function ShellHeader({
  logoHref,
  logoSub,
  email,
  profile,
  accountHref,
  tenantAppHref,
  adminLink,
  showGlobalSearch = false,
  notifications = [],
}: ShellHeaderProps) {
  return (
    <header
      className={`${styles.appHeader} ${showGlobalSearch ? styles.appHeaderWithSearch : ""}`}
      data-reos-header=""
    >
      <Link href={logoHref} className={styles.headerBrand}>
        <img
          src="/realtoros-logo.png"
          alt="RealtorOS"
          className={styles.headerLogo}
        />
        {logoSub && <span className={styles.logoSub}>{logoSub}</span>}
      </Link>

      {showGlobalSearch && (
        <div className={styles.headerSearch}>
          <GlobalSearch />
        </div>
      )}

      <div className={styles.headerActions}>
        {adminLink && (
          <Link href="/admin" className={styles.headerAdminLink}>
            Admin
          </Link>
        )}
        <NotificationsMenu initialNotifications={notifications} />
        <UserMenu
          email={email}
          displayName={profile.displayName}
          avatarUrl={profile.avatarUrl}
          accountHref={accountHref}
          tenantAppHref={tenantAppHref}
          compact
        />
      </div>
    </header>
  );
}
