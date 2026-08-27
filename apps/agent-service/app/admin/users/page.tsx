import Link from "next/link";
import { NewUserModal } from "../_components/new-user-modal";
import { UsersHeaderActions } from "../_components/users-header-actions";
import { UsersPagination } from "../_components/users-pagination";
import { fetchUsersList, parseUsersListParams } from "@/lib/admin/users-list";
import { listTenantOptions } from "@/lib/admin/tenant-options";
import {
  buildSortHref,
  type UserSortColumn,
  type UsersListParams,
} from "@/lib/admin/users-list-params";
import { displayValue } from "@/components/shell/inline-edit";
import { UserAvatar } from "@/components/shell/user-avatar";
import type { TenantUserRole } from "@/lib/admin/tenant-users";
import { formatPhoneDisplay } from "@/lib/phone-display";
import styles from "@/components/shell/shell.module.css";

interface PageProps {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

function UserTypeBadge({ role, label }: { role: TenantUserRole; label: string }) {
  const className =
    role === "owner" ? styles.badgeRole : role === "viewer" ? styles.badgeRoleMuted : styles.badgeActive;

  return <span className={`${styles.badge} ${className}`}>{label}</span>;
}

function IconSort({ direction }: { direction: "asc" | "desc" | null }) {
  const upOpacity = direction === "desc" ? 0.35 : direction === "asc" ? 1 : 0.55;
  const downOpacity = direction === "asc" ? 0.35 : direction === "desc" ? 1 : 0.55;

  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path
        d="M8 9l4-4 4 4"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        opacity={upOpacity}
      />
      <path
        d="M8 15l4 4 4-4"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        opacity={downOpacity}
      />
    </svg>
  );
}

function SortHeader({
  label,
  column,
  params,
}: {
  label: string;
  column: UserSortColumn;
  params: UsersListParams;
}) {
  const active = params.sort === column;
  const nextDir = active && params.dir === "asc" ? "descending" : "ascending";

  return (
    <div className={styles.tableSortHeader}>
      <span>{label}</span>
      <Link
        href={`/admin/users${buildSortHref(params, column)}`}
        className={`${styles.tableSortBtn} ${active ? styles.tableSortBtnActive : ""}`}
        aria-label={`Sort by ${label} ${nextDir}`}
      >
        <IconSort direction={active ? params.dir : null} />
      </Link>
    </div>
  );
}

export default async function AdminUsersPage({ searchParams }: PageProps) {
  const resolved = await searchParams;
  const params = parseUsersListParams(resolved);
  const [{ rows, total }, tenants] = await Promise.all([
    fetchUsersList(params),
    listTenantOptions(),
  ]);
  const hasFilters = params.q.length > 0 || params.role !== "all";

  return (
    <>
      <div className={styles.pageHeader}>
        <div>
          <h1 className={styles.pageTitle}>Users</h1>
        </div>
        <div className={styles.pageHeaderActions}>
          <UsersHeaderActions params={params} />
          <NewUserModal tenants={tenants} />
        </div>
      </div>

      {rows.length === 0 ? (
        <p className={styles.empty}>
          {hasFilters ? (
            "No users match your filters."
          ) : tenants.length === 0 ? (
            "No users yet. Create an account first."
          ) : (
            <>
              No users yet. <NewUserModal trigger="link" tenants={tenants} />.
            </>
          )}
        </p>
      ) : (
        <>
          <div className={styles.tableWrap}>
            <table className={styles.table}>
              <thead>
                <tr>
                  <th>
                    <SortHeader label="Name" column="name" params={params} />
                  </th>
                  <th>Email</th>
                  <th>
                    <SortHeader label="Account" column="account" params={params} />
                  </th>
                  <th>
                    <SortHeader label="User Type" column="role" params={params} />
                  </th>
                  <th>Phone</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((user) => (
                  <tr key={user.membershipId}>
                    <td>
                      <div className={styles.tableCellPerson}>
                        <UserAvatar email={user.email} avatarUrl={user.avatarUrl} />
                        <span className={styles.tableCellName}>{user.name}</span>
                      </div>
                    </td>
                    <td>{user.email}</td>
                    <td>
                      <Link
                        href={`/admin/accounts/${user.tenantId}`}
                        className={styles.tableCellLink}
                      >
                        {user.tenantName}
                      </Link>
                    </td>
                    <td>
                      <UserTypeBadge role={user.userType} label={user.userTypeLabel} />
                    </td>
                    <td>{formatPhoneDisplay(user.phone) ?? displayValue(null)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <UsersPagination params={params} total={total} />
          </div>
        </>
      )}
    </>
  );
}
