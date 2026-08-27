"use client";

import { useRouter } from "next/navigation";
import { IconBillingTenants } from "./billing-stat-card";
import { DropdownSelect } from "@/components/shell/dropdown-select";
import type { BillingTenantOption } from "@/lib/admin/billing-stats";
import { accountInitials } from "@/lib/user-display";
import styles from "@/components/shell/shell.module.css";

interface BillingTenantSelectProps {
  tenantOptions: BillingTenantOption[];
  selectedTenantId?: string;
}

function AllTenantsIcon() {
  return (
    <span className={`${styles.billingDropdownIcon} ${styles.billingDropdownIconAll}`}>
      <IconBillingTenants />
    </span>
  );
}

function TenantIcon({ name }: { name: string }) {
  return (
    <span className={`${styles.billingDropdownIcon} ${styles.billingDropdownIconTenant}`}>
      {accountInitials(name)}
    </span>
  );
}

export function BillingTenantSelect({
  tenantOptions,
  selectedTenantId,
}: BillingTenantSelectProps) {
  const router = useRouter();

  const options = [
    {
      value: "all",
      label: "All tenants",
      leading: <AllTenantsIcon />,
    },
    ...tenantOptions.map((tenant) => ({
      value: tenant.id,
      label: tenant.name,
      leading: <TenantIcon name={tenant.name} />,
    })),
  ];

  return (
    <div className={styles.billingTenantSelect}>
      <DropdownSelect
        value={selectedTenantId ?? "all"}
        onChange={(value) => {
          if (value === "all") {
            router.push("/admin/billing");
            return;
          }
          router.push(`/admin/billing/tenants/${value}`);
        }}
        options={options}
        variant="inline"
        ariaLabel="Select tenant billing scope"
      />
    </div>
  );
}
