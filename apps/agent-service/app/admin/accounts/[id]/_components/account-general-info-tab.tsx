"use client";

import { useState } from "react";
import { AccountBillingForm } from "./account-billing-form";
import { AccountConnectionsSections } from "./account-connections-sections";
import { AccountUsersSection } from "./account-users-section";
import type { TenantConfig } from "@/lib/admin/tenant-config";
import type { TenantUser } from "@/lib/admin/tenant-users";
import styles from "@/components/shell/shell.module.css";

interface AccountGeneralInfoTabProps {
  tenant: TenantConfig;
  users: TenantUser[];
}

function AccordionChevron({ open }: { open: boolean }) {
  return (
    <svg
      className={`${styles.accordionChevron} ${open ? styles.accordionChevronOpen : ""}`}
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      aria-hidden="true"
    >
      <path
        d="M6 9l6 6 6-6"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export function AccountGeneralInfoTab({ tenant, users }: AccountGeneralInfoTabProps) {
  const [usersOpen, setUsersOpen] = useState(false);
  const [billingOpen, setBillingOpen] = useState(true);

  return (
    <div className={styles.accordionList}>
      <section className={styles.accordionSection}>
        <button
          type="button"
          className={styles.accordionTrigger}
          aria-expanded={billingOpen}
          onClick={() => setBillingOpen((open) => !open)}
        >
          <span className={styles.accordionTriggerMain}>
            <span className={`${styles.accordionIconBadge} ${styles.accordionIconBilling}`}>
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                <rect x="2" y="5" width="20" height="14" rx="2" stroke="currentColor" strokeWidth="2" />
                <path d="M2 10h20" stroke="currentColor" strokeWidth="2" />
              </svg>
            </span>
            <span>Billing</span>
          </span>
          <AccordionChevron open={billingOpen} />
        </button>

        {billingOpen && (
          <div className={styles.accordionPanel}>
            <AccountBillingForm tenant={tenant} />
          </div>
        )}
      </section>

      <section className={styles.accordionSection}>
        <button
          type="button"
          className={styles.accordionTrigger}
          aria-expanded={usersOpen}
          onClick={() => setUsersOpen((open) => !open)}
        >
          <span className={styles.accordionTriggerMain}>
            <span className={`${styles.accordionIconBadge} ${styles.accordionIconUsers}`}>
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                <path
                  d="M16 21v-2a4 4 0 00-4-4H6a4 4 0 00-4 4v2M9 11a4 4 0 100-8 4 4 0 000 8zM22 21v-2a4 4 0 00-3-3.87M16 3.13a4 4 0 010 7.75"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
            </span>
            <span>
              Users{" "}
              <span className={styles.accordionTriggerCount}>({users.length})</span>
            </span>
          </span>
          <AccordionChevron open={usersOpen} />
        </button>

        {usersOpen && (
          <div className={styles.accordionPanel}>
            <AccountUsersSection tenantId={tenant.id} users={users} />
          </div>
        )}
      </section>

      <AccountConnectionsSections tenant={tenant} />
    </div>
  );
}
