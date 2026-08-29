import { requirePlatformAdmin } from "@/lib/admin/auth";
import { getCurrentProfile } from "@/lib/profile/server";
import { listUserNotifications } from "@/lib/notifications/notifications";
import { AdminShell } from "./_components/admin-shell";

export default async function AdminLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const admin = await requirePlatformAdmin();
  const [profile, notifications] = await Promise.all([
    getCurrentProfile(admin.id, admin.email),
    listUserNotifications(admin.id, { limit: 25 }),
  ]);

  return (
    <AdminShell email={admin.email} profile={profile} notifications={notifications}>
      {children}
    </AdminShell>
  );
}
