"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { IntegrationAccordionCard } from "./integration-accordion-card";
import { IntegrationSourceBadge } from "./integration-source-badge";
import {
  clearResendStoredKeyAction,
  saveResendKeyAction,
} from "@/lib/admin/platform-secrets-actions";
import type { IntegrationsOverview } from "@/lib/admin/platform-secrets";
import styles from "@/components/shell/shell.module.css";

export function ResendIntegrationCard({ overview }: { overview: IntegrationsOverview }) {
  const router = useRouter();
  const [apiKey, setApiKey] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);
  const [pending, startTransition] = useTransition();

  function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
    setSuccess(false);

    const formData = new FormData(e.currentTarget);
    startTransition(async () => {
      const result = await saveResendKeyAction(formData);
      if (!result.ok) {
        setError(result.error ?? "Could not save Resend key.");
        return;
      }
      setApiKey("");
      setSuccess(true);
      router.refresh();
    });
  }

  function handleClearStored() {
    setError(null);
    setSuccess(false);
    startTransition(async () => {
      const result = await clearResendStoredKeyAction();
      if (!result.ok) {
        setError(result.error ?? "Could not remove stored key.");
        return;
      }
      router.refresh();
    });
  }

  return (
    <IntegrationAccordionCard
      title="Resend"
      subtitle="Transactional email for invites and product notifications"
      icon={
        <span className={`${styles.dashStatIcon} ${styles.dashStatIconBlue}`} aria-hidden="true">
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none">
            <path
              d="M4 6h16v12H4V6zm0 0l8 7 8-7"
              stroke="currentColor"
              strokeWidth="1.75"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </span>
      }
      meta={
        <>
          <IntegrationSourceBadge source={overview.resend.source} />
          {overview.resend.hint && (
            <span className={styles.integrationHint}>Current: {overview.resend.hint}</span>
          )}
        </>
      }
    >
      {!overview.encryptionEnabled && (
        <p className={styles.integrationNotice}>
          Set <code>PLATFORM_SECRETS_ENCRYPTION_KEY</code> to save keys in the database. Until
          then, use <code>RESEND_API_KEY</code> in the environment.
        </p>
      )}

      <p className={styles.integrationNotice}>
        For Auth invites and password emails, also set Supabase custom SMTP: host{" "}
        <code>smtp.resend.com</code>, port <code>465</code>, username <code>resend</code>,
        password = this API key, and a verified sender address.
      </p>

      <form className={styles.integrationForm} onSubmit={handleSubmit}>
        <label className={styles.label} htmlFor="resend-api-key">
          API key
        </label>
        <input
          id="resend-api-key"
          name="apiKey"
          type="password"
          className={styles.input}
          placeholder="re_…"
          value={apiKey}
          onChange={(e) => setApiKey(e.target.value)}
          autoComplete="off"
          disabled={!overview.encryptionEnabled || pending}
        />
        <div className={styles.integrationFormActions}>
          <button
            type="submit"
            className={styles.btnPrimary}
            disabled={!overview.encryptionEnabled || pending || apiKey.trim().length === 0}
          >
            {pending ? "Saving…" : "Save Key"}
          </button>
          {overview.resend.source === "database" && (
            <button
              type="button"
              className={styles.btnSecondary}
              disabled={pending}
              onClick={handleClearStored}
            >
              Remove stored key
            </button>
          )}
        </div>
      </form>

      {error && <p className={styles.error}>{error}</p>}
      {success && <p className={styles.success}>Resend key saved.</p>}
    </IntegrationAccordionCard>
  );
}
