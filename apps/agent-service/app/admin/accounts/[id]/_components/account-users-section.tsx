"use client";

import type { TenantUser } from "@/lib/admin/tenant-users";
import { AccountUsersTable } from "./account-users-table";

interface AccountUsersSectionProps {
  tenantId: string;
  users: TenantUser[];
}

export function AccountUsersSection({ tenantId, users }: AccountUsersSectionProps) {
  return <AccountUsersTable tenantId={tenantId} users={users} />;
}
