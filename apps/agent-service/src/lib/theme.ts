export type ThemePreference = "light" | "dark" | "system";

export const THEME_COOKIE = "reos-theme";
export const THEME_OPTIONS: ThemePreference[] = ["system", "light", "dark"];

export function isThemePreference(value: string): value is ThemePreference {
  return THEME_OPTIONS.includes(value as ThemePreference);
}

export function resolveTheme(
  preference: ThemePreference,
  prefersDark = false,
): "light" | "dark" {
  if (preference === "system") {
    return prefersDark ? "dark" : "light";
  }
  return preference;
}

export function applyTheme(
  preference: ThemePreference,
  prefersDark?: boolean,
): void {
  if (typeof document === "undefined") return;

  const dark =
    prefersDark ??
    window.matchMedia("(prefers-color-scheme: dark)").matches;
  const resolved = resolveTheme(preference, dark);

  document.documentElement.dataset.theme = resolved;
  document.documentElement.style.colorScheme = resolved;
}
