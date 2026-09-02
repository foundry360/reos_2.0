"use client";

import { useState } from "react";
import { useSearchParams } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import styles from "./login.module.css";

export function LoginForm() {
  const searchParams = useSearchParams();
  const next = searchParams.get("next") || "/";
  const authError = searchParams.get("error");

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [rememberMe, setRememberMe] = useState(false);
  const [loading, setLoading] = useState(false);
  const [magicLinkSent, setMagicLinkSent] = useState(false);
  const [error, setError] = useState<string | null>(
    authError === "auth_callback_failed"
      ? "That invite or sign-in link is expired or invalid. Request a fresh invite from admin and open it in a private window."
      : null,
  );

  async function handlePasswordLogin(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setLoading(true);

    const supabase = createClient();
    let signInError: { message: string } | null = null;
    try {
      const result = await supabase.auth.signInWithPassword({
        email: email.trim(),
        password,
      });
      signInError = result.error;
    } catch (err) {
      setLoading(false);
      setError(err instanceof Error ? err.message : "Sign in failed. Please try again.");
      return;
    }

    setLoading(false);

    if (signInError) {
      setError(signInError.message);
      return;
    }

    window.location.href = next;
  }

  async function handleForgotPassword(e: React.MouseEvent) {
    e.preventDefault();
    if (!email.trim()) {
      setError("Enter your email address first.");
      return;
    }

    setError(null);
    setLoading(true);

    const supabase = createClient();
    const redirectTo = `${window.location.origin}/auth/callback?next=${encodeURIComponent("/set-password")}`;
    const { error: resetError } = await supabase.auth.resetPasswordForEmail(email.trim(), {
      redirectTo,
    });

    setLoading(false);

    if (resetError) {
      setError(resetError.message);
      return;
    }

    setMagicLinkSent(true);
  }

  async function handleMagicLink() {
    if (!email.trim()) {
      setError("Enter your email address first.");
      return;
    }

    setError(null);
    setLoading(true);

    const supabase = createClient();
    const redirectTo = `${window.location.origin}/auth/callback?next=${encodeURIComponent(next)}`;
    const { error: otpError } = await supabase.auth.signInWithOtp({
      email: email.trim(),
      options: { emailRedirectTo: redirectTo },
    });

    setLoading(false);

    if (otpError) {
      setError(otpError.message);
      return;
    }

    setMagicLinkSent(true);
  }

  return (
    <div className={styles.left}>
      <div className={styles.leftCenter}>
        <div className={styles.logo}>
          <img
            src="/realtoros-logo-light.png"
            alt="RealtorOS"
            className={styles.logoImg}
          />
        </div>

        <div className={styles.card}>
        <h1 className={styles.cardTitle}>REOS login</h1>

        {error && <p className={styles.error}>{error}</p>}
        {magicLinkSent && (
          <p className={styles.success}>
            Check your email for a sign-in link. It may take a minute to arrive.
          </p>
        )}

        <form onSubmit={handlePasswordLogin}>
          <div className={styles.field}>
            <label className={styles.label} htmlFor="email">
              Email
            </label>
            <input
              id="email"
              className={styles.input}
              type="email"
              autoComplete="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              disabled={loading}
              required
            />
          </div>

          <div className={styles.field}>
            <label className={styles.label} htmlFor="password">
              Password
            </label>
            <input
              id="password"
              className={styles.input}
              type="password"
              autoComplete={rememberMe ? "current-password" : "off"}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              disabled={loading}
              required
            />
          </div>

          <button className={styles.btnPrimary} type="submit" disabled={loading}>
            {loading ? "Signing in…" : "Log In"}
          </button>

          <div className={styles.row}>
            <label className={styles.checkboxLabel}>
              <input
                type="checkbox"
                checked={rememberMe}
                onChange={(e) => setRememberMe(e.target.checked)}
              />
              Remember me
            </label>
            <button
              type="button"
              className={styles.link}
              onClick={handleForgotPassword}
              disabled={loading}
              style={{
                background: "none",
                border: "none",
                padding: 0,
                cursor: "pointer",
                font: "inherit",
              }}
            >
              Forgot your password?
            </button>
          </div>
        </form>

        <div className={styles.divider}>or</div>

        <button
          type="button"
          className={styles.btnSecondary}
          onClick={handleMagicLink}
          disabled={loading}
        >
          <span aria-hidden>✉</span>
          Log In with Email Link
        </button>
      </div>

      <div className={styles.footerCta}>
        <p>Not a customer?</p>
        <a className={styles.btnOutline} href="mailto:support@foundry360.com">
          Contact us
        </a>
      </div>
      </div>

      <footer className={styles.pageFooter}>
        © {new Date().getFullYear()} Foundry360 ·{" "}
        <a href="/privacy" target="_blank" rel="noopener noreferrer">
          Privacy
        </a>
        {" · "}
        <a href="/terms" target="_blank" rel="noopener noreferrer">
          Terms of Service
        </a>
      </footer>
    </div>
  );
}
