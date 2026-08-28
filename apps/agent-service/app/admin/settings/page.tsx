import { requirePlatformAdmin } from "@/lib/admin/auth";
import { listPlatformAdmins } from "@/lib/admin/platform-admin-actions";
import { getCurrentProfile } from "@/lib/profile/server";
import { AccountSettingsForm } from "./_components/account-settings-form";
import { AppearanceSettings } from "./_components/appearance-settings";
import { UserManagement } from "./_components/user-management";
import { PageHeading } from "@/components/shell/page-heading";
import { IconSettings } from "@/components/shell/sidebar-nav";
import styles from "@/components/shell/shell.module.css";

export default async function AdminSettingsPage() {
  const admin = await requirePlatformAdmin();
  const [profile, admins] = await Promise.all([
    getCurrentProfile(admin.id, admin.email),
    listPlatformAdmins(),
  ]);

  return (
    <>
      <div className={styles.pageHeader}>
        <PageHeading
          icon={<IconSettings />}
          title="Settings"
          subtitle="Manage your account, appearance, and platform admins."
          tone="dark"
        />
      </div>

      <div className={styles.settingsPageStack}>
        <div className={styles.card}>
          <AccountSettingsForm
            email={admin.email}
            displayName={profile.displayName}
            avatarUrl={profile.avatarUrl}
          />
        </div>

        <div className={styles.card}>
          <AppearanceSettings themePreference={profile.themePreference} />
        </div>

        <div className={styles.card}>
          <UserManagement admins={admins} currentUserId={admin.id} />
        </div>
      </div>
    </>
  );
}
