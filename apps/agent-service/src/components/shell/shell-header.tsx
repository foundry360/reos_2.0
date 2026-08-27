import Link from "next/link";
import styles from "./shell.module.css";
import { UserMenu } from "./user-menu";
import type { UserProfile } from "@/lib/profile/server";

interface ShellHeaderProps {
  logoHref: string;
  logoSub?: string;
  email: string;
  profile: UserProfile;
  accountHref?: string;
  tenantAppHref?: string;
  adminLink?: boolean;
}

export function ShellHeader({
  logoHref,
  logoSub,
  email,
  profile,
  accountHref,
  tenantAppHref,
  adminLink,
}: ShellHeaderProps) {
  return (
    <header className={styles.appHeader} data-reos-header="">
      <Link href={logoHref} className={styles.headerBrand}>
        <span className={styles.logoMark}>R2</span>
        <span>REOS</span>
        {logoSub && <span className={styles.logoSub}>{logoSub}</span>}
      </Link>
      <div className={styles.headerActions}>
        {adminLink && (
          <Link href="/admin" className={styles.headerAdminLink}>
            Admin
          </Link>
        )}
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
