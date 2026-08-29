"use client";

import { useEffect, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { updateNotificationPreferencesAction } from "@/lib/notifications/actions";
import {
  NOTIFICATION_CATEGORY_META,
  type NotificationPreferences,
} from "@/lib/notifications/types";
import styles from "@/components/shell/shell.module.css";

export function NotificationSettings({
  initialPreferences,
}: {
  initialPreferences: NotificationPreferences;
}) {
  const router = useRouter();
  const [prefs, setPrefs] = useState(initialPreferences);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  useEffect(() => {
    setPrefs(initialPreferences);
  }, [initialPreferences]);

  function toggle(key: keyof NotificationPreferences) {
    const next = { ...prefs, [key]: !prefs[key] };
    setError(null);
    setPrefs(next);

    startTransition(async () => {
      const result = await updateNotificationPreferencesAction(next);
      if (!result.ok) {
        setError(result.error ?? "Could not save notification settings.");
        setPrefs(initialPreferences);
        return;
      }
      router.refresh();
    });
  }

  return (
    <div className={styles.settingsStack}>
      <section className={styles.settingsSection}>
        <h2 className={styles.settingsSectionTitle}>Notifications</h2>
        <p className={styles.settingsSectionDesc}>
          All notification types are on by default. Turn any off if you do not
          want them in the header bell. Changes save automatically.
        </p>

        {error ? <p className={styles.error}>{error}</p> : null}

        <div className={styles.notificationToggleStack}>
          {NOTIFICATION_CATEGORY_META.map((category) => {
            const checked = prefs[category.prefKey];
            return (
              <div key={category.id} className={styles.notificationToggleRow}>
                <div className={styles.notificationToggleCopy}>
                  <p className={styles.notificationToggleLabel}>{category.label}</p>
                  <p className={styles.notificationToggleDesc}>{category.description}</p>
                </div>
                <button
                  type="button"
                  className={`${styles.toggleSwitch} ${
                    checked ? styles.toggleSwitchOn : ""
                  }`}
                  role="switch"
                  aria-checked={checked}
                  aria-label={category.label}
                  disabled={pending}
                  onClick={() => toggle(category.prefKey)}
                >
                  <span className={styles.toggleSwitchThumb} aria-hidden />
                </button>
              </div>
            );
          })}
        </div>
      </section>
    </div>
  );
}
