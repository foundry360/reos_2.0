import { requirePlatformAdmin } from "@/lib/admin/auth";
import { getCurrentProfile } from "@/lib/profile/server";
import { listUserNotifications } from "@/lib/notifications/notifications";
import { listAssignedTenants } from "@/lib/tenant/current-tenant";
import { AdminShell } from "./_components/admin-shell";

export default async function AdminLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const admin = await requirePlatformAdmin();
  const [profile, notifications, assignedTenants] = await Promise.all([
    getCurrentProfile(admin.id, admin.email),
    listUserNotifications(admin.id, { limit: 25 }),
    listAssignedTenants(admin.id),
  ]);

  return (
    <AdminShell
      email={admin.email}
      profile={profile}
      notifications={notifications}
      assignedTenants={assignedTenants}
    >
      {children}
    </AdminShell>
  );
}
