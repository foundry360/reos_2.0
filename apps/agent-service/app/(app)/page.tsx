import Link from "next/link";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { isPlatformAdmin } from "@/lib/admin/auth";
import styles from "@/components/shell/shell.module.css";

interface PageProps {
  searchParams: Promise<{ error?: string }>;
}

export default async function HomePage({ searchParams }: PageProps) {
  const { error } = await searchParams;
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    redirect("/login");
  }

  const platformAdmin = await isPlatformAdmin(user.id);

  return (
    <>
      <div className={styles.pageHeader}>
        <div>
          <h1 className={styles.pageTitle}>Home</h1>
          <p className={styles.pageSubtitle}>Your workspace overview</p>
        </div>
      </div>

      {error === "not_platform_admin" && (
        <p className={styles.notice}>
          You are signed in but not a platform admin. Ask ops to add your user to{" "}
          <code>platform_admins</code> in Supabase.
        </p>
      )}

      <div className={styles.card} style={{ padding: "1.25rem" }}>
        <p style={{ margin: "0 0 0.75rem", color: "#444", lineHeight: 1.5 }}>
          {platformAdmin
            ? "Open an account from the admin portal to preview a tenant workspace."
            : "Inbox and pipeline are coming in the next milestone."}
        </p>
        {platformAdmin && (
          <Link href="/admin" className={styles.btnPrimary}>
            Go to admin portal
          </Link>
        )}
      </div>
    </>
  );
}
