import { Suspense } from "react";
import { redirect } from "next/navigation";
import { getWorkspaceChannels } from "@/lib/channels/workspace-channels";
import { getWorkspaceAccess } from "@/lib/tenant/workspace-access";
import { ChannelsSettings } from "./_components/channels-settings";
import styles from "@/components/shell/shell.module.css";

export default async function ChannelsSettingsPage() {
  const access = await getWorkspaceAccess();
  if (!access) redirect("/login?next=/settings/channels");

  if (!access.canManageChannels) {
    return (
      <div className={styles.settingsPageStack}>
        <div className={styles.card}>
          <p className={styles.empty}>
            Only workspace owners can manage channels. Ask your workspace owner for help.
          </p>
        </div>
      </div>
    );
  }

  const channels = await getWorkspaceChannels(access.tenantId);

  return (
    <div className={styles.settingsPageStack}>
      <div className={styles.card}>
        <Suspense fallback={null}>
          <ChannelsSettings tenantId={access.tenantId} channels={channels} />
        </Suspense>
      </div>
    </div>
  );
}
