import { createClient } from "@/lib/supabase/server";
import { redirect } from "next/navigation";
import { isPlatformAdmin } from "@/lib/admin/auth";
import { getImpersonatedTenantId, stopImpersonation } from "@/lib/admin/actions";
import { getSupabaseAdmin } from "@/lib/supabase/admin";
import { getCurrentProfile } from "@/lib/profile/server";
import { TenantShell } from "./_components/tenant-shell";
import styles from "@/components/shell/shell.module.css";

export default async function AppLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user?.email) {
    redirect("/login");
  }

  const platformAdmin = await isPlatformAdmin(user.id);
  const profile = await getCurrentProfile(user.id, user.email);
  const impersonateId = await getImpersonatedTenantId();

  let impersonatedTenant: { name: string } | null = null;
  if (impersonateId && platformAdmin) {
    const admin = getSupabaseAdmin();
    if (admin) {
      const { data } = await admin
        .from("tenants")
        .select("name")
        .eq("id", impersonateId)
        .maybeSingle();
      impersonatedTenant = data;
    }
  }

  const impersonateBanner = impersonatedTenant ? (
    <div className={styles.impersonateBanner}>
      <span>
        Viewing <strong>{impersonatedTenant.name}</strong> as platform admin
      </span>
      <form action={stopImpersonation}>
        <button type="submit" className={styles.impersonateExit}>
          Exit to admin
        </button>
      </form>
    </div>
  ) : null;

  return (
    <TenantShell
      email={user.email}
      profile={profile}
      showAdminLink={platformAdmin}
      impersonateBanner={impersonateBanner}
    >
      {children}
    </TenantShell>
  );
}
