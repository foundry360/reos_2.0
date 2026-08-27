"use client";

import { useEffect, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { updateThemeAction } from "@/lib/profile/actions";
import { applyTheme, type ThemePreference } from "@/lib/theme";
import styles from "@/components/shell/shell.module.css";

const THEMES: { value: ThemePreference; label: string; image: string }[] = [
  { value: "system", label: "System", image: "/theme/system.png?v=2" },
  { value: "light", label: "Light", image: "/theme/light.png?v=3" },
  { value: "dark", label: "Dark", image: "/theme/dark.png" },
];

interface AppearanceSettingsProps {
  themePreference: ThemePreference;
}

export function AppearanceSettings({ themePreference }: AppearanceSettingsProps) {
  const router = useRouter();
  const [selected, setSelected] = useState(themePreference);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  useEffect(() => {
    setSelected(themePreference);
  }, [themePreference]);

  function handleSelect(theme: ThemePreference) {
    setError(null);
    setSelected(theme);
    applyTheme(theme);

    startTransition(async () => {
      const result = await updateThemeAction(theme);
      if (!result.ok) {
        setError(result.error ?? "Could not save theme.");
        setSelected(themePreference);
        applyTheme(themePreference);
        return;
      }
      router.refresh();
    });
  }

  return (
    <div className={styles.settingsStack}>
      <section className={styles.settingsSection}>
        <h2 className={styles.settingsSectionTitle}>Appearance</h2>
        <p className={styles.settingsSectionDesc}>
          Choose how REOS looks to you. Select a single theme, or sync with your
          system.
        </p>

        {error && <p className={styles.error}>{error}</p>}

        <div className={styles.themeGrid}>
          {THEMES.map((theme) => (
            <button
              key={theme.value}
              type="button"
              className={`${styles.themeOption} ${selected === theme.value ? styles.themeOptionActive : ""}`}
              onClick={() => handleSelect(theme.value)}
              disabled={pending}
              aria-pressed={selected === theme.value}
            >
              <span className={styles.themePreview} aria-hidden>
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={theme.image} alt="" className={styles.themePreviewImg} />
              </span>
              <span className={styles.themeOptionLabel}>
                <span className={styles.themeRadio} aria-hidden />
                {theme.label}
              </span>
            </button>
          ))}
        </div>
      </section>
    </div>
  );
}
