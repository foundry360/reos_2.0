import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { getCurrentProfile } from "@/lib/profile/server";
import { getNotificationPreferences } from "@/lib/notifications/notifications";
import { AccountSettingsForm } from "../../admin/settings/_components/account-settings-form";
import { AppearanceSettings } from "../../admin/settings/_components/appearance-settings";
import { NotificationSettings } from "./_components/notification-settings";
import { PageHeading } from "@/components/shell/page-heading";
import { IconSettings } from "@/components/shell/sidebar-nav";
import styles from "@/components/shell/shell.module.css";

export default async function TenantSettingsPage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user?.email) {
    redirect("/login?next=/settings");
  }

  const [profile, notificationPreferences] = await Promise.all([
    getCurrentProfile(user.id, user.email),
    getNotificationPreferences(user.id),
  ]);

  return (
    <>
      <div className={styles.pageHeader}>
        <PageHeading
          icon={<IconSettings />}
          title="Settings"
          subtitle="Manage your account, appearance, and notifications."
          tone="dark"
        />
      </div>

      <div className={styles.settingsPageStack}>
        <div className={styles.card}>
          <AccountSettingsForm
            email={user.email}
            displayName={profile.displayName}
            avatarUrl={profile.avatarUrl}
          />
        </div>

        <div className={styles.card}>
          <AppearanceSettings themePreference={profile.themePreference} />
        </div>

        <div className={styles.card}>
          <NotificationSettings initialPreferences={notificationPreferences} />
        </div>
      </div>
    </>
  );
}
