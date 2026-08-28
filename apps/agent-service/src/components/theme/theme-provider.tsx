"use client";

import { useEffect } from "react";
import { applyTheme, type ThemePreference } from "@/lib/theme";

interface ThemeProviderProps {
  preference: ThemePreference;
  children: React.ReactNode;
}

export function ThemeProvider({ preference, children }: ThemeProviderProps) {
  useEffect(() => {
    const onAuthSurface = /^\/(login|set-password)(\/|$)/.test(window.location.pathname);
    if (onAuthSurface) {
      applyTheme("light");
      return;
    }

    applyTheme(preference);

    if (preference !== "system") return;

    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const onChange = () => applyTheme("system", media.matches);

    media.addEventListener("change", onChange);
    return () => media.removeEventListener("change", onChange);
  }, [preference]);

  return children;
}
