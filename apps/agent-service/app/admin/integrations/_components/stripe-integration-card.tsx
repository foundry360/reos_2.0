"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { IntegrationAccordionCard } from "./integration-accordion-card";
import { IntegrationSourceBadge } from "./integration-source-badge";
import {
  clearStripeStoredSecretsAction,
  saveStripeCredentialsAction,
  testStripeConnectionAction,
} from "@/lib/admin/platform-secrets-actions";
import type { IntegrationsOverview } from "@/lib/admin/platform-secrets";
import styles from "@/components/shell/shell.module.css";

interface StripeIntegrationCardProps {
  overview: IntegrationsOverview;
  webhookUrl: string;
}

export function StripeIntegrationCard({ overview, webhookUrl }: StripeIntegrationCardProps) {
  const router = useRouter();
  const [secretKey, setSecretKey] = useState("");
  const [webhookSecret, setWebhookSecret] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const [testPending, startTestTransition] = useTransition();

  function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
    setSuccess(null);

    const formData = new FormData(e.currentTarget);
    startTransition(async () => {
      const result = await saveStripeCredentialsAction(formData);
      if (!result.ok) {
        setError(result.error ?? "Could not save Stripe credentials.");
        return;
      }

      setSecretKey("");
      setWebhookSecret("");
      setSuccess("Stripe credentials saved.");

      if (secretKey.trim()) {
        const test = await testStripeConnectionAction();
        if (test.ok && test.mode) {
          setSuccess(`Stripe connected (${test.mode} mode).`);
        }
      }

      router.refresh();
    });
  }

  function handleTestConnection() {
    setError(null);
    setSuccess(null);
    startTestTransition(async () => {
      const result = await testStripeConnectionAction();
      if (!result.ok) {
        setError(result.error ?? "Stripe connection failed.");
        return;
      }
      setSuccess(`Stripe connection verified (${result.mode} mode).`);
    });
  }

  function handleClearStored() {
    setError(null);
    setSuccess(null);
    startTransition(async () => {
      const result = await clearStripeStoredSecretsAction();
      if (!result.ok) {
        setError(result.error ?? "Could not remove stored credentials.");
        return;
      }
      router.refresh();
    });
  }

  return (
    <IntegrationAccordionCard
      title="Billing (Stripe)"
      subtitle="Platform secret key for charging tenant payment methods"
      icon={
        <span className={`${styles.dashStatIcon} ${styles.billingStatIconPurple}`} aria-hidden="true">
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none">
            <rect x="3" y="6" width="18" height="12" rx="2" stroke="currentColor" strokeWidth="1.75" />
            <path d="M3 10h18" stroke="currentColor" strokeWidth="1.75" />
          </svg>
        </span>
      }
      meta={
        <>
          <IntegrationSourceBadge source={overview.stripe.source} />
          {overview.stripe.secretKey.hint && (
            <span className={styles.integrationHint}>Key: {overview.stripe.secretKey.hint}</span>
          )}
          {overview.stripe.webhookSecret.hint && (
            <span className={styles.integrationHint}>
              Webhook: {overview.stripe.webhookSecret.hint}
            </span>
          )}
        </>
      }
    >
      <div className={styles.integrationWebhookBox}>
        <p className={styles.integrationWebhookLabel}>Webhook endpoint</p>
        <code className={styles.integrationWebhookUrl}>{webhookUrl}</code>
      </div>

      {!overview.encryptionEnabled && (
        <p className={styles.integrationNotice}>
          Set <code>PLATFORM_SECRETS_ENCRYPTION_KEY</code> to save credentials in the database.
        </p>
      )}

      <form className={styles.integrationForm} onSubmit={handleSubmit}>
        <label className={styles.label} htmlFor="stripe-secret-key">
          Secret key
        </label>
        <input
          id="stripe-secret-key"
          name="secretKey"
          type="password"
          className={styles.input}
          placeholder="sk_live_… or sk_test_…"
          value={secretKey}
          onChange={(e) => setSecretKey(e.target.value)}
          autoComplete="off"
          disabled={pending}
        />

        <label className={styles.label} htmlFor="stripe-webhook-secret">
          Webhook signing secret
        </label>
        <input
          id="stripe-webhook-secret"
          name="webhookSecret"
          type="password"
          className={styles.input}
          placeholder="whsec_…"
          value={webhookSecret}
          onChange={(e) => setWebhookSecret(e.target.value)}
          autoComplete="off"
          disabled={pending}
        />

        <div className={styles.integrationFormActions}>
          <button
            type="submit"
            className={styles.btnPrimary}
            disabled={
              pending ||
              (secretKey.trim().length === 0 && webhookSecret.trim().length === 0)
            }
          >
            {pending ? "Saving…" : "Save Credentials"}
          </button>
          {overview.stripe.configured && (
            <button
              type="button"
              className={styles.btnSecondary}
              disabled={testPending || pending}
              onClick={handleTestConnection}
            >
              {testPending ? "Testing…" : "Test connection"}
            </button>
          )}
          {overview.stripe.source === "database" && (
            <button
              type="button"
              className={styles.btnSecondary}
              disabled={pending || testPending}
              onClick={handleClearStored}
            >
              Remove stored credentials
            </button>
          )}
        </div>
      </form>

      {error && <p className={styles.error}>{error}</p>}
      {success && <p className={styles.success}>{success}</p>}
    </IntegrationAccordionCard>
  );
}
