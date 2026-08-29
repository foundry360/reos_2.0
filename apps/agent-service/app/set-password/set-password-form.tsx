"use client";

import { useEffect, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import styles from "../login/login.module.css";

export function SetPasswordClient() {
  const [email, setEmail] = useState<string | null>(null);
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [booting, setBooting] = useState(true);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    async function bootstrap() {
      const supabase = createClient();
      const url = new URL(window.location.href);
      const code = url.searchParams.get("code");

      if (code) {
        const { error: exchangeError } = await supabase.auth.exchangeCodeForSession(code);
        if (exchangeError) {
          if (!cancelled) {
            setError(exchangeError.message);
            setBooting(false);
          }
          return;
        }
        window.history.replaceState({}, "", "/set-password");
      } else if (url.hash.includes("access_token")) {
        // Implicit invite/recovery redirect: let the client parse the hash.
        await new Promise<void>((resolve) => {
          const {
            data: { subscription },
          } = supabase.auth.onAuthStateChange((event) => {
            if (event === "INITIAL_SESSION" || event === "SIGNED_IN") {
              subscription.unsubscribe();
              resolve();
            }
          });
          window.setTimeout(() => {
            subscription.unsubscribe();
            resolve();
          }, 2500);
        });
        window.history.replaceState({}, "", "/set-password");
      }

      const {
        data: { user },
      } = await supabase.auth.getUser();

      if (cancelled) return;

      if (!user?.email) {
        setError(
          "This invite or reset link is expired or invalid. Ask your admin to resend the invite.",
        );
        setBooting(false);
        return;
      }

      setEmail(user.email);
      setBooting(false);
    }

    void bootstrap();
    return () => {
      cancelled = true;
    };
  }, []);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);

    if (password.length < 8) {
      setError("Password must be at least 8 characters.");
      return;
    }
    if (password !== confirm) {
      setError("Passwords do not match.");
      return;
    }

    setLoading(true);
    const supabase = createClient();
    const { error: updateError } = await supabase.auth.updateUser({ password });
    setLoading(false);

    if (updateError) {
      setError(updateError.message);
      return;
    }

    window.location.href = "/";
  }

  return (
    <div className={styles.left}>
      <div className={styles.leftCenter}>
        <div className={styles.logo}>
          <span className={styles.logoMark}>R2</span>
          REOS
        </div>

        <div className={styles.card}>
          <h1 className={styles.cardTitle}>Set your password</h1>

          {booting ? (
            <p
              style={{
                margin: 0,
                textAlign: "center",
                fontSize: "0.875rem",
                color: "var(--shell-text-secondary)",
              }}
            >
              Preparing your account…
            </p>
          ) : (
            <>
              {email && (
                <p
                  style={{
                    margin: "0 0 1.25rem",
                    textAlign: "center",
                    fontSize: "0.875rem",
                    color: "var(--shell-text-secondary)",
                    lineHeight: 1.45,
                  }}
                >
                  Choose a password for <strong>{email}</strong> so you can sign in next time.
                </p>
              )}

              {error && <p className={styles.error}>{error}</p>}

              {email && (
                <form onSubmit={handleSubmit}>
                  <div className={styles.field}>
                    <label className={styles.label} htmlFor="password">
                      Password
                    </label>
                    <input
                      id="password"
                      className={styles.input}
                      type="password"
                      autoComplete="new-password"
                      value={password}
                      onChange={(e) => setPassword(e.target.value)}
                      disabled={loading}
                      required
                      minLength={8}
                    />
                  </div>

                  <div className={styles.field}>
                    <label className={styles.label} htmlFor="confirm">
                      Confirm password
                    </label>
                    <input
                      id="confirm"
                      className={styles.input}
                      type="password"
                      autoComplete="new-password"
                      value={confirm}
                      onChange={(e) => setConfirm(e.target.value)}
                      disabled={loading}
                      required
                      minLength={8}
                    />
                  </div>

                  <button className={styles.btnPrimary} type="submit" disabled={loading}>
                    {loading ? "Saving…" : "Save Password And Continue"}
                  </button>
                </form>
              )}

              {!email && (
                <p style={{ margin: "1rem 0 0", textAlign: "center" }}>
                  <a className={styles.link} href="/login">
                    Back To Login
                  </a>
                </p>
              )}
            </>
          )}
        </div>
      </div>

      <footer className={styles.pageFooter}>
        © {new Date().getFullYear()} Foundry360
      </footer>
    </div>
  );
}
