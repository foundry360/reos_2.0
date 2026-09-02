"use client";

import { useEffect, useMemo, useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { NewLeadModal } from "../../../app/(app)/leads/_components/new-lead-modal";
import {
  getEmailComposeBootstrapAction,
  lookupContactByEmailAction,
  sendEmailAction,
} from "@/lib/email/send-email-action";
import { useEmailCompose } from "@/components/email/email-compose-provider";
import { EmailRichTextEditor } from "@/components/email/email-rich-text-editor";
import {
  contactPrefillRecipient,
  formatSignatureHtml,
  parseRecipientList,
} from "@/lib/email/email-utils";
import styles from "@/components/email/email.module.css";

export function EmailComposeWidget() {
  const {
    open,
    minimized,
    draft,
    context,
    needsSignature,
    closeCompose,
    minimizeCompose,
    restoreCompose,
    setDraft,
    setContext,
    markSignatureApplied,
    resetDraft,
  } = useEmailCompose();

  const [bootstrap, setBootstrap] = useState<Awaited<
    ReturnType<typeof getEmailComposeBootstrapAction>
  > | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [unknownRecipientEmail, setUnknownRecipientEmail] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const router = useRouter();

  useEffect(() => {
    if (!open && !minimized) return;
    void getEmailComposeBootstrapAction().then(setBootstrap);
  }, [open, minimized]);

  useEffect(() => {
    if (!open || !needsSignature || !bootstrap?.signature || draft.bodyHtml.trim()) return;
    setDraft({ bodyHtml: formatSignatureHtml(bootstrap.signature) }, { markDirty: false });
    markSignatureApplied();
  }, [
    open,
    needsSignature,
    bootstrap?.signature,
    draft.bodyHtml,
    setDraft,
    markSignatureApplied,
  ]);

  const singleRecipientEmail = useMemo(() => {
    if (context.contactId) return null;
    const recipients = parseRecipientList(draft.to);
    return recipients.length === 1 ? recipients[0].email : null;
  }, [context.contactId, draft.to]);

  useEffect(() => {
    if (!open || context.contactId || !singleRecipientEmail) {
      setUnknownRecipientEmail(null);
      return;
    }

    let cancelled = false;
    const timer = window.setTimeout(async () => {
      const match = await lookupContactByEmailAction(singleRecipientEmail);
      if (cancelled) return;
      if (match) {
        setUnknownRecipientEmail(null);
        setContext({
          contactId: match.id,
          contactName: match.name,
          contactEmail: match.email,
        });
        return;
      }
      setUnknownRecipientEmail(singleRecipientEmail);
    }, 400);

    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [open, context.contactId, singleRecipientEmail, setContext]);

  function send() {
    setError(null);
    setSuccess(null);
    startTransition(async () => {
      const result = await sendEmailAction({
        to: draft.to,
        cc: draft.cc,
        subject: draft.subject,
        bodyHtml: draft.bodyHtml,
        contactId: context.contactId,
        opportunityId: context.opportunityId,
        threadId: context.threadId,
      });
      if (!result.ok) {
        setError(result.error ?? "Could not send email.");
        return;
      }
      setSuccess("Email sent.");
      resetDraft();
      router.refresh();
      window.setTimeout(() => {
        closeCompose();
        setSuccess(null);
      }, 1200);
    });
  }

  if (!open && !minimized) {
    return null;
  }

  if (minimized) {
    return (
      <div
        className={`${styles.widget} ${styles.widgetMinimized}`}
        role="dialog"
        aria-label="New email"
      >
        <div className={styles.widgetHeader}>
          <button
            type="button"
            className={styles.widgetMinimizedRestore}
            onClick={restoreCompose}
            aria-label="Restore email composer"
          >
            New Email
          </button>
          <div className={styles.widgetHeaderActions}>
            <button
              type="button"
              className={styles.widgetIconBtn}
              onClick={closeCompose}
              aria-label="Close"
            >
              ×
            </button>
          </div>
        </div>
      </div>
    );
  }

  const connected = bootstrap?.connected ?? false;
  const fromLabel = bootstrap?.accounts[0]
    ? bootstrap.accounts[0].label
      ? `${bootstrap.accounts[0].label} <${bootstrap.accounts[0].email}>`
      : bootstrap.accounts[0].email
    : "";

  return (
    <div className={styles.widget} role="dialog" aria-label="New email">
      <div className={styles.widgetHeader}>
        <span className={styles.widgetTitle}>New Email</span>
        <div className={styles.widgetHeaderActions}>
          <button
            type="button"
            className={styles.widgetIconBtn}
            onClick={minimizeCompose}
            aria-label="Minimize"
          >
            ─
          </button>
          <button
            type="button"
            className={styles.widgetIconBtn}
            onClick={closeCompose}
            aria-label="Close"
          >
            ×
          </button>
        </div>
      </div>

      {!connected ? (
        <div className={styles.widgetEmpty}>
          <p className={styles.widgetEmptyTitle}>Connect Email</p>
          <p className={styles.widgetEmptyText}>
            Connect your Gmail account to send and track customer emails directly from REOS.
          </p>
          {bootstrap?.showAdminConnect ? (
            <Link href="/admin" className={styles.widgetPrimaryBtn}>
              Connect in Admin
            </Link>
          ) : (
            <p className={styles.widgetHint}>Ask your workspace admin to connect Gmail.</p>
          )}
        </div>
      ) : (
        <>
          <div className={styles.widgetFields}>
            <label className={styles.fieldRow}>
              <span className={styles.fieldLabel}>From</span>
              <span className={styles.fieldStatic}>{fromLabel}</span>
            </label>
            <label className={styles.fieldRow}>
              <span className={styles.fieldLabel}>To</span>
              <input
                className={styles.fieldInput}
                value={draft.to}
                onChange={(event) => setDraft({ to: event.target.value })}
                placeholder="name@example.com"
              />
            </label>
            <label className={styles.fieldRow}>
              <span className={styles.fieldLabel}>Cc</span>
              <input
                className={styles.fieldInput}
                value={draft.cc}
                onChange={(event) => setDraft({ cc: event.target.value })}
                placeholder="Optional"
              />
            </label>
            <label className={styles.fieldRow}>
              <span className={styles.fieldLabel}>Subject</span>
              <input
                className={styles.fieldInput}
                value={draft.subject}
                onChange={(event) => setDraft({ subject: event.target.value })}
                placeholder="Subject"
              />
            </label>
          </div>

          <EmailRichTextEditor
            value={draft.bodyHtml}
            onChange={(bodyHtml) => setDraft({ bodyHtml })}
          />

          {context.contactName ? (
            <p className={styles.widgetContext}>
              Linked to {context.contactName}
              {context.opportunityName ? ` · ${context.opportunityName}` : ""}
            </p>
          ) : null}

          {unknownRecipientEmail ? (
            <div className={styles.widgetContactHint}>
              <p className={styles.widgetHint}>No matching contact found.</p>
              <NewLeadModal
                trigger="link"
                linkLabel="Create Contact"
                defaultEmail={unknownRecipientEmail}
                onCreated={(created) => {
                  setUnknownRecipientEmail(null);
                  setContext({
                    contactId: created.id,
                    contactName: created.name,
                    contactEmail: created.email,
                  });
                  setDraft(
                    { to: contactPrefillRecipient(created.name, created.email) },
                    { markDirty: false },
                  );
                }}
              />
            </div>
          ) : null}

          {error ? <p className={styles.widgetError}>{error}</p> : null}
          {success ? <p className={styles.widgetSuccess}>{success}</p> : null}

          <div className={styles.widgetFooter}>
            <button type="button" className={styles.widgetSecondaryBtn} disabled title="Coming soon">
              Attach
            </button>
            <button
              type="button"
              className={styles.widgetPrimaryBtn}
              onClick={send}
              disabled={pending}
            >
              {pending ? "Sending…" : "Send Email"}
            </button>
          </div>
        </>
      )}
    </div>
  );
}
