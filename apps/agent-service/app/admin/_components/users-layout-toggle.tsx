"use client";

import { buildUsersListQuery, type UsersListParams } from "@/lib/admin/users-list-params";
import { AdminLayoutToggle } from "./admin-layout-toggle";

interface UsersLayoutToggleProps {
  params: UsersListParams;
}

export function UsersLayoutToggle({ params }: UsersLayoutToggleProps) {
  return (
    <AdminLayoutToggle
      layout={params.layout}
      buildHref={(layout) =>
        `/admin/users${buildUsersListQuery({ ...params, layout, page: 1 })}`
      }
    />
  );
}
