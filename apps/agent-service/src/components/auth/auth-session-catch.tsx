"use client";

import { useEffect } from "react";

/**
 * Supabase recovery/invite emails often land on Site URL (`/`) with
 * `?code=`, `?token_hash=`, or `#access_token=...&type=recovery`.
 * Forward those to /set-password (or /auth/confirm for token_hash) before
 * middleware sends an authenticated session to /overview or /admin.
 */
export function AuthSessionCatch() {
  useEffect(() => {
    const url = new URL(window.location.href);
    if (url.pathname !== "/" && url.pathname !== "") return;

    const hash = url.hash.startsWith("#") ? url.hash.slice(1) : url.hash;
    const hashParams = new URLSearchParams(hash);
    const code = url.searchParams.get("code");
    const tokenHash =
      url.searchParams.get("token_hash") || hashParams.get("token_hash");
    const type =
      url.searchParams.get("type") || hashParams.get("type") || "";

    if (tokenHash && type) {
      const confirm = new URL("/auth/confirm", window.location.origin);
      confirm.searchParams.set("token_hash", tokenHash);
      confirm.searchParams.set("type", type);
      confirm.searchParams.set("next", "/set-password");
      window.location.replace(confirm.toString());
      return;
    }

    const hasToken =
      hashParams.has("access_token") ||
      hashParams.has("refresh_token") ||
      Boolean(code);

    if (!hasToken) return;

    const target = new URL("/set-password", window.location.origin);
    if (code) target.searchParams.set("code", code);
    // Preserve full search (e.g. type) except when only hash tokens exist.
    for (const [key, value] of url.searchParams.entries()) {
      if (key === "code") continue;
      target.searchParams.set(key, value);
    }
    window.location.replace(`${target.pathname}${target.search}${url.hash}`);
  }, []);

  return null;
}
