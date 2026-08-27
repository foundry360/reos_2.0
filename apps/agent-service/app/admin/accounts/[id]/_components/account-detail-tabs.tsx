"use client";

import { useState } from "react";
import { AccountDetailsTab } from "./account-details-tab";
import { AccountGeneralInfoTab } from "./account-general-info-tab";
import type { TenantConfig } from "@/lib/admin/tenant-config";
import type { TenantUser } from "@/lib/admin/tenant-users";
import styles from "@/components/shell/shell.module.css";

type AccountTab = "details" | "general";

const TABS: { id: AccountTab; label: string }[] = [
  { id: "general", label: "General Info" },
  { id: "details", label: "Details" },
];

interface AccountDetailTabsProps {
  tenant: TenantConfig;
  users: TenantUser[];
}

export function AccountDetailTabs({ tenant, users }: AccountDetailTabsProps) {
  const [activeTab, setActiveTab] = useState<AccountTab>("general");

  return (
    <div className={styles.accountDetailCard}>
      <div className={styles.tabBar} role="tablist" aria-label="Account sections">
        {TABS.map((tab) => (
          <button
            key={tab.id}
            type="button"
            role="tab"
            aria-selected={activeTab === tab.id}
            className={`${styles.tabBtn} ${activeTab === tab.id ? styles.tabBtnActive : ""}`}
            onClick={() => setActiveTab(tab.id)}
          >
            {tab.label}
          </button>
        ))}
      </div>

      <div className={styles.tabPanel} role="tabpanel">
        {activeTab === "details" && <AccountDetailsTab tenant={tenant} />}
        {activeTab === "general" && <AccountGeneralInfoTab tenant={tenant} users={users} />}
      </div>
    </div>
  );
}
