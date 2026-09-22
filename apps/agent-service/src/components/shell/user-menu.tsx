"use client";

import Link from "next/link";
import { useEffect, useRef, useState, useTransition } from "react";
import { signOutAction } from "@/lib/auth/actions";
import { selectTenantWorkspaceAction } from "@/lib/admin/account-actions";
import { UserAvatar } from "./user-avatar";
import styles from "./shell.module.css";

export interface UserMenuTenant {
  id: string;
  name: string;
}

export interface UserMenuProps {
  email: string;
  displayName?: string;
  avatarUrl?: string | null;
  accountHref?: string;
  tenantAppHref?: string;
  tenantWorkspaces?: UserMenuTenant[];
  compact?: boolean;
}

export function UserMenu({
  email,
  displayName,
  avatarUrl,
  accountHref,
  tenantAppHref,
  tenantWorkspaces = [],
  compact = false,
}: UserMenuProps) {
  const [open, setOpen] = useState(false);
  const [pending, startTransition] = useTransition();
  const ref = useRef<HTMLDivElement>(null);

  const name = displayName ?? email.split("@")[0];
  const showAccountLink = Boolean(accountHref);
  const showTenantLink = tenantWorkspaces.length === 0 && Boolean(tenantAppHref);

  useEffect(() => {
    function onDocClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener("mousedown", onDocClick);
    return () => document.removeEventListener("mousedown", onDocClick);
  }, []);

  function openWorkspace(tenantId: string) {
    startTransition(async () => {
      const result = await selectTenantWorkspaceAction(tenantId);
      if (!result.ok) {
        console.error(result.error ?? "Could not open workspace.");
        return;
      }
      window.location.assign("/overview");
    });
  }

  return (
    <div className={styles.userMenu} ref={ref}>
      <button
        type="button"
        className={`${styles.avatarBtn} ${compact ? styles.avatarBtnCompact : ""}`}
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-haspopup="menu"
        aria-label="Account menu"
        disabled={pending}
      >
        <UserAvatar email={email} displayName={displayName} avatarUrl={avatarUrl} />
        {!compact && (
          <>
            <span className={styles.avatarMeta}>
              <span className={styles.avatarName}>{name}</span>
              <span className={styles.avatarEmail}>{email}</span>
            </span>
            <span className={styles.avatarChevron} aria-hidden>
              ▾
            </span>
          </>
        )}
      </button>

      {open && (
        <div className={styles.menuDropdown} role="menu">
          <div className={styles.menuHeader}>
            <UserAvatar
              email={email}
              displayName={displayName}
              avatarUrl={avatarUrl}
              className={styles.menuAvatarImg}
            />
            <div>
              <span className={styles.menuName}>{name}</span>
              <span className={styles.menuEmail}>{email}</span>
            </div>
          </div>

          <div className={styles.menuSection}>
            {showAccountLink && (
              <Link
                className={styles.dropdownItem}
                href={accountHref!}
                role="menuitem"
                onClick={() => setOpen(false)}
              >
                Account
              </Link>
            )}

            {tenantWorkspaces.map((tenant) => (
              <button
                key={tenant.id}
                type="button"
                className={styles.dropdownItem}
                role="menuitem"
                disabled={pending}
                onClick={() => openWorkspace(tenant.id)}
              >
                {pending ? "Opening…" : tenant.name}
              </button>
            ))}

            {showTenantLink && (
              <Link
                className={styles.dropdownItem}
                href={tenantAppHref!}
                role="menuitem"
                onClick={() => setOpen(false)}
              >
                Tenant app
              </Link>
            )}
            <form action={signOutAction}>
              <button
                type="submit"
                className={`${styles.dropdownItem} ${styles.dropdownItemDanger}`}
                disabled={pending}
              >
                Sign Out
              </button>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
