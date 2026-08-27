import { requirePlatformAdmin } from "@/lib/admin/auth";
import { getCurrentProfile } from "@/lib/profile/server";
import { AdminShell } from "./_components/admin-shell";

export default async function AdminLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const admin = await requirePlatformAdmin();
  const profile = await getCurrentProfile(admin.id, admin.email);

  return (
    <AdminShell email={admin.email} profile={profile}>
      {children}
    </AdminShell>
  );
}
