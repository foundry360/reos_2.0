"use client";

import { useEffect, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import styles from "../login/login.module.css";

type AuthEmailType = "invite" | "signup" | "magiclink" | "recovery" | "email";

function readHashParams(): URLSearchParams {
  const hash = window.location.hash.startsWith("#")
    ? window.location.hash.slice(1)
    : window.location.hash;
  return new URLSearchParams(hash);
}

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
      const hashParams = readHashParams();

      const oauthError =
        url.searchParams.get("error_description") ||
        url.searchParams.get("error") ||
        hashParams.get("error_description") ||
        hashParams.get("error");
      if (oauthError) {
        if (!cancelled) {
          setError(decodeURIComponent(oauthError.replace(/\+/g, " ")));
          setBooting(false);
        }
        return;
      }

      const code = url.searchParams.get("code");
      const tokenHash =
        url.searchParams.get("token_hash") || hashParams.get("token_hash");
      const type = (url.searchParams.get("type") ||
        hashParams.get("type") ||
        "") as AuthEmailType | "";

      if (tokenHash && type) {
        const { error: otpError } = await supabase.auth.verifyOtp({
          type: type as AuthEmailType,
          token_hash: tokenHash,
        });
        if (otpError) {
          if (!cancelled) {
            setError(otpError.message);
            setBooting(false);
          }
          return;
        }
        window.history.replaceState({}, "", "/set-password");
      } else if (code) {
        const { error: exchangeError } = await supabase.auth.exchangeCodeForSession(code);
        if (exchangeError) {
          if (!cancelled) {
            // PKCE fails when the email is opened in a different browser than
            // the one that requested the reset — guide the user clearly.
            const pkceHint = /code verifier|pkce|both auth code|flow state/i.test(
              exchangeError.message,
            )
              ? " Open the link in the same browser where you requested the reset, or request a new reset email from this browser."
              : "";
            setError(`${exchangeError.message}.${pkceHint}`);
            setBooting(false);
          }
          return;
        }
        window.history.replaceState({}, "", "/set-password");
      } else if (
        hashParams.has("access_token") &&
        hashParams.has("refresh_token")
      ) {
        const { error: sessionError } = await supabase.auth.setSession({
          access_token: hashParams.get("access_token")!,
          refresh_token: hashParams.get("refresh_token")!,
        });
        if (sessionError) {
          if (!cancelled) {
            setError(sessionError.message);
            setBooting(false);
          }
          return;
        }
        window.history.replaceState({}, "", "/set-password");
      } else if (url.hash.includes("access_token")) {
        // Fallback: let the client parse an implicit hash if setSession fields differ.
        await new Promise<void>((resolve) => {
          const {
            data: { subscription },
          } = supabase.auth.onAuthStateChange((event) => {
            if (event === "INITIAL_SESSION" || event === "SIGNED_IN" || event === "PASSWORD_RECOVERY") {
              subscription.unsubscribe();
              resolve();
            }
          });
          window.setTimeout(() => {
            subscription.unsubscribe();
            resolve();
          }, 4000);
        });
        window.history.replaceState({}, "", "/set-password");
      }

      const {
        data: { user },
      } = await supabase.auth.getUser();

      if (cancelled) return;

      if (!user?.email) {
        setError(
          "This invite or reset link is expired or invalid. Request a new reset from the login page (Forgot password), and open the email link in the same browser.",
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

    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (user) {
      const { resolvePostLoginPath } = await import("@/lib/auth/post-login-path");
      window.location.href = await resolvePostLoginPath(supabase, user.id, "/overview");
      return;
    }
    window.location.href = "/login";
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
