"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { IntegrationAccordionCard } from "./integration-accordion-card";
import { IntegrationSourceBadge } from "./integration-source-badge";
import {
  clearOpenAIStoredKeyAction,
  saveOpenAIKeyAction,
} from "@/lib/admin/platform-secrets-actions";
import type { IntegrationsOverview } from "@/lib/admin/platform-secrets";
import styles from "@/components/shell/shell.module.css";

export function OpenAIIntegrationCard({ overview }: { overview: IntegrationsOverview }) {
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
      const result = await saveOpenAIKeyAction(formData);
      if (!result.ok) {
        setError(result.error ?? "Could not save OpenAI key.");
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
      const result = await clearOpenAIStoredKeyAction();
      if (!result.ok) {
        setError(result.error ?? "Could not remove stored key.");
        return;
      }
      router.refresh();
    });
  }

  return (
    <IntegrationAccordionCard
      title="OpenAI"
      subtitle="Platform API key for agent replies"
      icon={
        <span className={`${styles.dashStatIcon} ${styles.dashStatIconBlue}`} aria-hidden="true">
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none">
            <path
              d="M12 3c3.5 2.2 7 2.5 9 3.5-1.2 6.5-5 10.5-9 14.5C8 17 4 13 3 6.5 5 5.5 8.5 5.2 12 3z"
              stroke="currentColor"
              strokeWidth="1.75"
              strokeLinejoin="round"
            />
          </svg>
        </span>
      }
      meta={
        <>
          <IntegrationSourceBadge source={overview.openai.source} />
          {overview.openai.hint && (
            <span className={styles.integrationHint}>Current: {overview.openai.hint}</span>
          )}
        </>
      }
    >
      {!overview.encryptionEnabled && (
        <p className={styles.integrationNotice}>
          Set <code>PLATFORM_SECRETS_ENCRYPTION_KEY</code> to save keys in the database. Until
          then, use environment variables only.
        </p>
      )}

      <form className={styles.integrationForm} onSubmit={handleSubmit}>
        <label className={styles.label} htmlFor="openai-api-key">
          API key
        </label>
        <input
          id="openai-api-key"
          name="apiKey"
          type="password"
          className={styles.input}
          placeholder="sk-…"
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
          {overview.openai.source === "database" && (
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
      {success && <p className={styles.success}>OpenAI key saved.</p>}
    </IntegrationAccordionCard>
  );
}
