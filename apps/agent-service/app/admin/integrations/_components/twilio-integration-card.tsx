"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import {
  clearTwilioStoredSecretsAction,
  saveTwilioCredentialsAction,
} from "@/lib/admin/platform-secrets-actions";
import type { IntegrationsOverview } from "@/lib/admin/platform-secrets";
import styles from "@/components/shell/shell.module.css";

function SourceBadge({ source }: { source: IntegrationsOverview["twilio"]["source"] }) {
  const label =
    source === "database"
      ? "Stored encrypted"
      : source === "environment"
        ? "Environment variable"
        : "Not configured";

  return <span className={styles.integrationSourceBadge}>{label}</span>;
}

export function TwilioIntegrationCard({ overview }: { overview: IntegrationsOverview }) {
  const router = useRouter();
  const [accountSid, setAccountSid] = useState("");
  const [authToken, setAuthToken] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);
  const [pending, startTransition] = useTransition();

  function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
    setSuccess(false);

    const formData = new FormData(e.currentTarget);
    startTransition(async () => {
      const result = await saveTwilioCredentialsAction(formData);
      if (!result.ok) {
        setError(result.error ?? "Could not save Twilio credentials.");
        return;
      }
      setAccountSid("");
      setAuthToken("");
      setSuccess(true);
      router.refresh();
    });
  }

  function handleClearStored() {
    setError(null);
    setSuccess(false);
    startTransition(async () => {
      const result = await clearTwilioStoredSecretsAction();
      if (!result.ok) {
        setError(result.error ?? "Could not remove stored credentials.");
        return;
      }
      router.refresh();
    });
  }

  return (
    <section className={styles.integrationCard}>
      <div className={styles.integrationCardHeader}>
        <span className={`${styles.dashStatIcon} ${styles.billingStatIconAmber}`} aria-hidden="true">
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none">
            <path
              d="M8 4h8l4 6-8 10L4 10l4-6z"
              stroke="currentColor"
              strokeWidth="1.75"
              strokeLinejoin="round"
            />
          </svg>
        </span>
        <div>
          <h2 className={styles.integrationCardTitle}>Twilio</h2>
          <p className={styles.integrationCardSubtitle}>
            Platform Account SID and Auth Token for SMS
          </p>
        </div>
      </div>

      <div className={styles.integrationCardMeta}>
        <SourceBadge source={overview.twilio.source} />
        {overview.twilio.accountSid.hint && (
          <span className={styles.integrationHint}>SID: {overview.twilio.accountSid.hint}</span>
        )}
        {overview.twilio.authToken.hint && (
          <span className={styles.integrationHint}>Token: {overview.twilio.authToken.hint}</span>
        )}
      </div>

      {!overview.encryptionEnabled && (
        <p className={styles.integrationNotice}>
          Set <code>PLATFORM_SECRETS_ENCRYPTION_KEY</code> to save credentials in the database.
        </p>
      )}

      <form className={styles.integrationForm} onSubmit={handleSubmit}>
        <label className={styles.label} htmlFor="twilio-account-sid">
          Account SID
        </label>
        <input
          id="twilio-account-sid"
          name="accountSid"
          type="password"
          className={styles.input}
          placeholder="AC…"
          value={accountSid}
          onChange={(e) => setAccountSid(e.target.value)}
          autoComplete="off"
          disabled={!overview.encryptionEnabled || pending}
        />

        <label className={styles.label} htmlFor="twilio-auth-token">
          Auth token
        </label>
        <input
          id="twilio-auth-token"
          name="authToken"
          type="password"
          className={styles.input}
          placeholder="Auth token"
          value={authToken}
          onChange={(e) => setAuthToken(e.target.value)}
          autoComplete="off"
          disabled={!overview.encryptionEnabled || pending}
        />

        <div className={styles.integrationFormActions}>
          <button
            type="submit"
            className={styles.btnPrimary}
            disabled={
              !overview.encryptionEnabled ||
              pending ||
              accountSid.trim().length === 0 ||
              authToken.trim().length === 0
            }
          >
            {pending ? "Saving…" : "Save credentials"}
          </button>
          {overview.twilio.source === "database" && (
            <button
              type="button"
              className={styles.btnSecondary}
              disabled={pending}
              onClick={handleClearStored}
            >
              Remove stored credentials
            </button>
          )}
        </div>
      </form>

      {error && <p className={styles.error}>{error}</p>}
      {success && <p className={styles.success}>Twilio credentials saved.</p>}
    </section>
  );
}
