"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import styles from "@/components/shell/shell.module.css";

interface SettingsTab {
  href: string;
  label: string;
}

export function SettingsTabs({ tabs }: { tabs: SettingsTab[] }) {
  const pathname = usePathname();

  return (
    <nav className={styles.settingsTabs} aria-label="Settings sections">
      {tabs.map((tab) => {
        const active = pathname === tab.href;
        return (
          <Link
            key={tab.href}
            href={tab.href}
            className={`${styles.tabBtn} ${active ? styles.tabBtnActive : ""}`}
            aria-current={active ? "page" : undefined}
          >
            {tab.label}
          </Link>
        );
      })}
    </nav>
  );
}
