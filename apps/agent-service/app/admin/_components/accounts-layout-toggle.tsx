"use client";

import {
  buildAccountsListQuery,
  type AccountsListParams,
} from "@/lib/admin/accounts-list-params";
import { AdminLayoutToggle } from "./admin-layout-toggle";

interface AccountsLayoutToggleProps {
  params: AccountsListParams;
}

export function AccountsLayoutToggle({ params }: AccountsLayoutToggleProps) {
  return (
    <AdminLayoutToggle
      layout={params.layout}
      buildHref={(layout) =>
        `/admin${buildAccountsListQuery({ ...params, layout, page: 1 })}`
      }
    />
  );
}
