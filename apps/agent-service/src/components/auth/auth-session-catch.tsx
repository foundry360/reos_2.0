"use client";

import { useEffect } from "react";

/**
 * Supabase recovery/invite emails often land on Site URL (`/`) with
 * `?code=` or `#access_token=...&type=recovery`. Middleware cannot see the
 * hash and would send an authenticated user to /overview or /admin.
 * Forward those sessions to /set-password before that happens.
 */
export function AuthSessionCatch() {
  useEffect(() => {
    const url = new URL(window.location.href);
    const code = url.searchParams.get("code");
    const hash = url.hash.startsWith("#") ? url.hash.slice(1) : url.hash;
    const hashParams = new URLSearchParams(hash);
    const type = hashParams.get("type") ?? url.searchParams.get("type");
    const hasToken =
      hashParams.has("access_token") ||
      hashParams.has("refresh_token") ||
      Boolean(code);

    const isPasswordFlow =
      type === "recovery" ||
      type === "invite" ||
      type === "signup" ||
      // Implicit token on `/` without type still needs set-password handling.
      (hasToken && (url.pathname === "/" || url.pathname === ""));

    if (!hasToken || !isPasswordFlow) return;

    const target = new URL("/set-password", window.location.origin);
    if (code) target.searchParams.set("code", code);
    if (url.hash) {
      window.location.replace(`${target.pathname}${url.hash}`);
      return;
    }
    window.location.replace(target.toString());
  }, []);

  return null;
}
