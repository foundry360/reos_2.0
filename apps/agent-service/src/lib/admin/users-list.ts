import { requirePlatformAdmin } from "@/lib/admin/auth";
import type { UsersListParams } from "@/lib/admin/users-list-params";
import {
  formatUserTypeLabel,
  type TenantUserRole,
} from "@/lib/admin/tenant-users";
import { getSupabaseAdmin } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import { resolveProfileAvatarUrl } from "@/lib/user-display";

export type {
  PageSize,
  SortDirection,
  UserSortColumn,
  UsersListParams,
} from "@/lib/admin/users-list-params";
export {
  PAGE_SIZES,
  USER_SORT_COLUMNS,
  buildSortHref,
  buildUsersListQuery,
  parseUsersListParams,
} from "@/lib/admin/users-list-params";

export interface UserRow {
  membershipId: string;
  userId: string;
  name: string;
  email: string;
  phone: string | null;
  avatarUrl: string | null;
  userType: TenantUserRole;
  userTypeLabel: string;
  tenantId: string;
  tenantName: string;
  tenantSlug: string;
  createdAt: string;
}

export interface UsersListResult {
  rows: UserRow[];
  total: number;
  params: UsersListParams;
}

interface MembershipQueryRow {
  id: string;
  user_id: string;
  role: TenantUserRole;
  created_at: string;
  tenants:
    | {
        id: string;
        name: string;
        slug: string;
      }
    | {
        id: string;
        name: string;
        slug: string;
      }[]
    | null;
}

interface ProfileRow {
  id: string;
  display_name: string | null;
  phone: string | null;
  avatar_url: string | null;
}

function firstRelation<T>(value: T | T[] | null | undefined): T | null {
  if (!value) return null;
  return Array.isArray(value) ? (value[0] ?? null) : value;
}

function resolveDisplayName(
  displayName: string | null | undefined,
  email: string,
): string {
  const trimmed = displayName?.trim();
  if (trimmed) return trimmed;
  return email.split("@")[0] || "Unknown";
}

async function resolveSearchMembershipFilter(
  supabase: Awaited<ReturnType<typeof createClient>>,
  q: string,
): Promise<string | null> {
  const term = q.replace(/[%_,]/g, "");
  if (!term) return null;

  const [{ data: profileMatches }, { data: tenantMatches }] = await Promise.all([
    supabase.from("profiles").select("id").ilike("display_name", `%${term}%`),
    supabase
      .from("tenants")
      .select("id")
      .or(`name.ilike.%${term}%,slug.ilike.%${term}%`),
  ]);

  const userIds = profileMatches?.map((profile) => profile.id) ?? [];
  const tenantIds = tenantMatches?.map((tenant) => tenant.id) ?? [];

  if (userIds.length === 0 && tenantIds.length === 0) {
    return "";
  }

  const filters: string[] = [];
  if (userIds.length > 0) filters.push(`user_id.in.(${userIds.join(",")})`);
  if (tenantIds.length > 0) filters.push(`tenant_id.in.(${tenantIds.join(",")})`);
  return filters.join(",");
}

async function fetchProfilesByUserIds(userIds: string[]): Promise<Map<string, ProfileRow>> {
  if (userIds.length === 0) return new Map();

  const admin = getSupabaseAdmin();
  const client = admin ?? (await createClient());

  const { data, error } = await client
    .from("profiles")
    .select("id, display_name, phone, avatar_url")
    .in("id", userIds);

  if (error) {
    console.error("users list profile query failed:", error.message);
    return new Map();
  }

  return new Map((data ?? []).map((profile) => [profile.id, profile as ProfileRow]));
}

async function fetchEmailsByUserIds(userIds: string[]): Promise<Map<string, string>> {
  const emailByUserId = new Map<string, string>();
  const admin = getSupabaseAdmin();
  if (!admin || userIds.length === 0) return emailByUserId;

  await Promise.all(
    userIds.map(async (userId) => {
      const { data: authUser } = await admin.auth.admin.getUserById(userId);
      emailByUserId.set(userId, authUser.user?.email ?? "Unknown");
    }),
  );

  return emailByUserId;
}

function mapMembershipRows(
  memberships: MembershipQueryRow[],
  profilesByUserId: Map<string, ProfileRow>,
  emailByUserId: Map<string, string>,
): UserRow[] {
  return memberships.flatMap((membership) => {
    const tenant = firstRelation(membership.tenants);
    if (!tenant) return [];

    const profile = profilesByUserId.get(membership.user_id);
    const email = emailByUserId.get(membership.user_id) ?? "Unknown";
    const role = membership.role;

    return [
      {
        membershipId: membership.id,
        userId: membership.user_id,
        name: resolveDisplayName(profile?.display_name, email),
        email,
        phone: profile?.phone ?? null,
        avatarUrl: resolveProfileAvatarUrl(profile?.avatar_url),
        userType: role,
        userTypeLabel: formatUserTypeLabel(role),
        tenantId: tenant.id,
        tenantName: tenant.name,
        tenantSlug: tenant.slug,
        createdAt: membership.created_at,
      },
    ];
  });
}

async function fetchMembershipPage(
  supabase: Awaited<ReturnType<typeof createClient>>,
  params: UsersListParams,
  searchFilter: string | null,
): Promise<{ memberships: MembershipQueryRow[]; total: number }> {
  let query = supabase.from("memberships").select(
    `
      id,
      user_id,
      role,
      created_at,
      tenants!inner (
        id,
        name,
        slug
      )
    `,
    { count: "exact" },
  );

  if (searchFilter) {
    query = query.or(searchFilter);
  }

  if (params.role !== "all") {
    query = query.eq("role", params.role);
  }

  const ascending = params.dir === "asc";

  if (params.sort === "account") {
    query = query.order("name", { ascending, foreignTable: "tenants" });
  } else if (params.sort === "role") {
    query = query.order("role", { ascending });
  } else if (params.sort === "created_at") {
    query = query.order("created_at", { ascending });
  }

  const from = (params.page - 1) * params.perPage;
  const to = from + params.perPage - 1;

  const { data, count, error } = await query.range(from, to);

  if (error) {
    console.error("users list query failed:", error.message);
    return { memberships: [], total: 0 };
  }

  return {
    memberships: (data ?? []) as MembershipQueryRow[],
    total: count ?? 0,
  };
}

async function fetchMembershipPageSortedByName(
  supabase: Awaited<ReturnType<typeof createClient>>,
  params: UsersListParams,
  searchFilter: string | null,
): Promise<{ memberships: MembershipQueryRow[]; total: number }> {
  let query = supabase.from("memberships").select(
    `
      id,
      user_id,
      role,
      created_at,
      tenants!inner (
        id,
        name,
        slug
      )
    `,
    { count: "exact" },
  );

  if (searchFilter) {
    query = query.or(searchFilter);
  }

  if (params.role !== "all") {
    query = query.eq("role", params.role);
  }

  const { data, count, error } = await query;

  if (error) {
    console.error("users list query failed:", error.message);
    return { memberships: [], total: 0 };
  }

  const memberships = (data ?? []) as MembershipQueryRow[];
  const userIds = [...new Set(memberships.map((row) => row.user_id))];
  const profilesByUserId = await fetchProfilesByUserIds(userIds);
  const emailByUserId = await fetchEmailsByUserIds(userIds);

  const sorted = mapMembershipRows(memberships, profilesByUserId, emailByUserId).sort((a, b) => {
    const comparison = a.name.localeCompare(b.name, undefined, { sensitivity: "base" });
    return params.dir === "asc" ? comparison : -comparison;
  });

  const from = (params.page - 1) * params.perPage;
  const pageRows = sorted.slice(from, from + params.perPage);

  const membershipById = new Map(memberships.map((row) => [row.id, row]));
  const pageMemberships = pageRows.flatMap((row) => {
    const membership = membershipById.get(row.membershipId);
    return membership ? [membership] : [];
  });

  return {
    memberships: pageMemberships,
    total: count ?? sorted.length,
  };
}

export async function fetchUsersList(params: UsersListParams): Promise<UsersListResult> {
  await requirePlatformAdmin();
  const supabase = await createClient();

  let searchFilter: string | null = null;
  if (params.q) {
    searchFilter = await resolveSearchMembershipFilter(supabase, params.q);
    if (searchFilter === "") {
      return { rows: [], total: 0, params };
    }
  }

  const { memberships, total } =
    params.sort === "name"
      ? await fetchMembershipPageSortedByName(supabase, params, searchFilter)
      : await fetchMembershipPage(supabase, params, searchFilter);

  const userIds = [...new Set(memberships.map((row) => row.user_id))];
  const [profilesByUserId, emailByUserId] = await Promise.all([
    fetchProfilesByUserIds(userIds),
    fetchEmailsByUserIds(userIds),
  ]);

  const rows = mapMembershipRows(memberships, profilesByUserId, emailByUserId);

  return {
    rows,
    total,
    params,
  };
}
