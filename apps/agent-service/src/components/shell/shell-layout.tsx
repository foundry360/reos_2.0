"use client";

import { useEffect, useState, type ReactNode } from "react";
import { usePathname } from "next/navigation";
import styles from "./shell.module.css";

const STORAGE_KEY = "reos-sidebar-collapsed";

interface ShellLayoutProps {
  sidebar: ReactNode;
  secondarySidebar?: ReactNode;
  children: ReactNode;
}

function IconSidebarToggle() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path
        d="M15 18l-6-6 6-6"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export function ShellLayout({ sidebar, secondarySidebar, children }: ShellLayoutProps) {
  const pathname = usePathname();
  const [collapsed, setCollapsed] = useState(false);
  const hasSubnav =
    Boolean(secondarySidebar) &&
    (pathname === "/leads" ||
      pathname.startsWith("/leads/") ||
      pathname === "/contacts" ||
      pathname.startsWith("/contacts/"));

  useEffect(() => {
    try {
      setCollapsed(window.localStorage.getItem(STORAGE_KEY) === "1");
    } catch {
      setCollapsed(false);
    }
  }, []);

  function toggleSidebar() {
    setCollapsed((current) => {
      const next = !current;
      try {
        window.localStorage.setItem(STORAGE_KEY, next ? "1" : "0");
      } catch {
        // ignore storage failures
      }
      return next;
    });
  }

  return (
    <div
      className={styles.shellLayout}
      data-sidebar-collapsed={collapsed ? "true" : undefined}
      data-has-subnav={hasSubnav ? "true" : undefined}
    >
      <aside className={styles.sidebar}>
        <div className={styles.sidebarNav}>{sidebar}</div>
        <div className={styles.sidebarFooter}>
          <button
            type="button"
            className={styles.sidebarToggle}
            aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
            aria-expanded={!collapsed}
            onClick={toggleSidebar}
          >
            <span
              className={`${styles.sidebarToggleIcon} ${
                collapsed ? styles.sidebarToggleIconCollapsed : ""
              }`}
            >
              <IconSidebarToggle />
            </span>
          </button>
        </div>
      </aside>
      {hasSubnav ? <aside className={styles.subnav}>{secondarySidebar}</aside> : null}
      <main className={styles.main}>{children}</main>
    </div>
  );
}
