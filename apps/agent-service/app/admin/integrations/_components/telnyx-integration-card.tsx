"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { IntegrationAccordionCard } from "./integration-accordion-card";
import { IntegrationSourceBadge } from "./integration-source-badge";
import {
  clearTelnyxStoredSecretsAction,
  saveTelnyxCredentialsAction,
} from "@/lib/admin/platform-secrets-actions";
import type { IntegrationsOverview } from "@/lib/admin/platform-secrets";
import styles from "@/components/shell/shell.module.css";

export function TelnyxIntegrationCard({
  overview,
  webhookUrl,
}: {
  overview: IntegrationsOverview;
  webhookUrl: string;
}) {
  const router = useRouter();
  const [apiKey, setApiKey] = useState("");
  const [publicKey, setPublicKey] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);
  const [pending, startTransition] = useTransition();

  function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
    setSuccess(false);

    const formData = new FormData(e.currentTarget);
    startTransition(async () => {
      const result = await saveTelnyxCredentialsAction(formData);
      if (!result.ok) {
        setError(result.error ?? "Could not save Telnyx credentials.");
        return;
      }
      setApiKey("");
      setPublicKey("");
      setSuccess(true);
      router.refresh();
    });
  }

  function handleClearStored() {
    setError(null);
    setSuccess(false);
    startTransition(async () => {
      const result = await clearTelnyxStoredSecretsAction();
      if (!result.ok) {
        setError(result.error ?? "Could not remove stored credentials.");
        return;
      }
      router.refresh();
    });
  }

  return (
    <IntegrationAccordionCard
      title="Telnyx"
      subtitle="Platform API key for SMS and public key for webhook verification"
      icon={
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
      }
      meta={
        <>
          <IntegrationSourceBadge source={overview.telnyx.source} />
          {overview.telnyx.apiKey.hint && (
            <span className={styles.integrationHint}>API key: {overview.telnyx.apiKey.hint}</span>
          )}
          {overview.telnyx.publicKey.hint && (
            <span className={styles.integrationHint}>
              Public key: {overview.telnyx.publicKey.hint}
            </span>
          )}
        </>
      }
    >
      {!overview.encryptionEnabled && (
        <p className={styles.integrationNotice}>
          Set <code>PLATFORM_SECRETS_ENCRYPTION_KEY</code> to save credentials in the database.
        </p>
      )}

      <p className={styles.integrationNotice}>
        Point your Telnyx messaging profile&apos;s inbound webhook to <code>{webhookUrl}</code>.
      </p>

      <form className={styles.integrationForm} onSubmit={handleSubmit}>
        <label className={styles.label} htmlFor="telnyx-api-key">
          API key
        </label>
        <input
          id="telnyx-api-key"
          name="apiKey"
          type="password"
          className={styles.input}
          placeholder="KEY…"
          value={apiKey}
          onChange={(e) => setApiKey(e.target.value)}
          autoComplete="off"
          disabled={!overview.encryptionEnabled || pending}
        />

        <label className={styles.label} htmlFor="telnyx-public-key">
          Webhook public key
        </label>
        <input
          id="telnyx-public-key"
          name="publicKey"
          type="password"
          className={styles.input}
          placeholder="Base64 public key"
          value={publicKey}
          onChange={(e) => setPublicKey(e.target.value)}
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
              (apiKey.trim().length === 0 && publicKey.trim().length === 0)
            }
          >
            {pending ? "Saving…" : "Save Credentials"}
          </button>
          {overview.telnyx.source === "database" && (
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
      {success && <p className={styles.success}>Telnyx credentials saved.</p>}
    </IntegrationAccordionCard>
  );
}
