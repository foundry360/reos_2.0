"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { createLeadAction } from "@/lib/crm/crm-actions";
import {
  CONTACT_TYPE_OPTIONS,
  DEFAULT_CONTACT_TYPE,
  type ContactType,
} from "@/lib/crm/contact-type";
import {
  personSingular,
  personSingularTitle,
  type PersonKind,
} from "@/lib/crm/person-kind";
import { LEAD_STATUS_OPTIONS } from "@/lib/leads/lead-status";
import { DropdownSelect } from "@/components/shell/dropdown-select";
import { PhoneInput } from "@/components/shell/phone-input";
import { IconPlus } from "@/components/shell/sidebar-nav";
import type { LeadStatus } from "@/lib/coordinator";
import styles from "@/components/shell/shell.module.css";

interface NewLeadModalProps {
  trigger?: "pill" | "link" | "cta";
  linkLabel?: string;
  disabled?: boolean;
  kind?: PersonKind;
}

export function NewLeadModal({
  trigger = "pill",
  linkLabel,
  disabled = false,
  kind = "lead",
}: NewLeadModalProps) {
  const router = useRouter();
  const singular = personSingular(kind);
  const singularTitle = personSingularTitle(kind);
  const resolvedLinkLabel = linkLabel ?? `Add the first one`;
  const ctaLabel = linkLabel ?? `Add a ${singularTitle}`;
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const [firstName, setFirstName] = useState("");
  const [lastName, setLastName] = useState("");
  const [email, setEmail] = useState("");
  const [status, setStatus] = useState<LeadStatus>("New");
  const [contactType, setContactType] = useState<ContactType>(DEFAULT_CONTACT_TYPE);
  const panelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;

    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape" && !pending) setOpen(false);
    }

    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [open, pending]);

  useEffect(() => {
    if (open) {
      setError(null);
      document.body.style.overflow = "hidden";
    } else {
      document.body.style.overflow = "";
    }
    return () => {
      document.body.style.overflow = "";
    };
  }, [open]);

  function resetForm() {
    setFirstName("");
    setLastName("");
    setEmail("");
    setStatus("New");
    setContactType(DEFAULT_CONTACT_TYPE);
    setError(null);
  }

  function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
    const formData = new FormData(e.currentTarget);
    formData.set("recordType", kind);
    if (kind === "contact") {
      formData.set("contactType", contactType);
    } else {
      formData.set("status", status);
    }

    startTransition(async () => {
      const result = await createLeadAction(formData);
      if (!result.ok) {
        setError(result.error ?? `Could not create ${singular}.`);
        return;
      }
      resetForm();
      setOpen(false);
      router.refresh();
    });
  }

  return (
    <>
      {trigger === "pill" || trigger === "cta" ? (
        <button
          type="button"
          className={`${styles.btnPrimary} ${styles.btnPill}`}
          onClick={() => setOpen(true)}
          disabled={disabled}
        >
          {trigger === "pill" ? (
            <>
              <IconPlus />
              New {singular}
            </>
          ) : (
            ctaLabel
          )}
        </button>
      ) : (
        <button
          type="button"
          className={styles.modalLinkTrigger}
          onClick={() => setOpen(true)}
          disabled={disabled}
        >
          {resolvedLinkLabel}
        </button>
      )}

      {open && (
        <div className={styles.modalOverlay} onClick={() => !pending && setOpen(false)}>
          <div
            ref={panelRef}
            className={styles.modalPanel}
            role="dialog"
            aria-modal="true"
            aria-labelledby="new-lead-title"
            onClick={(e) => e.stopPropagation()}
          >
            <div className={styles.modalHeader}>
              <div>
                <h2 id="new-lead-title" className={styles.modalTitle}>
                  New {singular}
                </h2>
                <p className={styles.modalSubtitle}>
                  Add a person to your workspace. Phone numbers enable SMS conversations.
                </p>
              </div>
              <button
                type="button"
                className={styles.iconBtn}
                aria-label="Close"
                onClick={() => setOpen(false)}
                disabled={pending}
              >
                ×
              </button>
            </div>

            <form className={styles.modalBody} onSubmit={handleSubmit}>
              {error && <p className={styles.error}>{error}</p>}

              <div className={styles.inlineFieldRow}>
                <div className={styles.field}>
                  <label className={styles.label} htmlFor={`new-${kind}-first-name`}>
                    First name
                  </label>
                  <input
                    id={`new-${kind}-first-name`}
                    name="firstName"
                    className={styles.input}
                    value={firstName}
                    onChange={(e) => setFirstName(e.target.value)}
                    placeholder="Jane"
                    disabled={pending}
                  />
                </div>
                <div className={styles.field}>
                  <label className={styles.label} htmlFor={`new-${kind}-last-name`}>
                    Last name
                  </label>
                  <input
                    id={`new-${kind}-last-name`}
                    name="lastName"
                    className={styles.input}
                    value={lastName}
                    onChange={(e) => setLastName(e.target.value)}
                    placeholder="Smith"
                    disabled={pending}
                  />
                </div>
              </div>

              <div className={styles.field}>
                <label className={styles.label} htmlFor={`new-${kind}-phone`}>
                  Phone
                </label>
                <PhoneInput
                  id={`new-${kind}-phone`}
                  name="phone"
                  className={styles.input}
                  disabled={pending}
                />
              </div>

              <div className={styles.field}>
                <label className={styles.label} htmlFor={`new-${kind}-email`}>
                  Email
                </label>
                <input
                  id={`new-${kind}-email`}
                  name="email"
                  type="email"
                  className={styles.input}
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="jane@example.com"
                  disabled={pending}
                />
              </div>

              <div className={styles.field}>
                <label className={styles.label} htmlFor={`new-${kind}-status`}>
                  {kind === "contact" ? "Contact type" : "Status"}
                </label>
                {kind === "contact" ? (
                  <DropdownSelect
                    id={`new-${kind}-status`}
                    value={contactType}
                    ariaLabel="Contact type"
                    disabled={pending}
                    onChange={(value) => setContactType(value as ContactType)}
                    options={CONTACT_TYPE_OPTIONS.map((option) => ({
                      value: option.value,
                      label: option.label,
                    }))}
                  />
                ) : (
                  <DropdownSelect
                    id={`new-${kind}-status`}
                    value={status}
                    ariaLabel={`${singularTitle} status`}
                    disabled={pending}
                    onChange={(value) => setStatus(value as LeadStatus)}
                    options={LEAD_STATUS_OPTIONS.map((option) => ({
                      value: option.value,
                      label: option.label,
                    }))}
                  />
                )}
              </div>

              <div className={styles.modalFooter}>
                <button
                  type="button"
                  className={styles.btnSecondary}
                  onClick={() => setOpen(false)}
                  disabled={pending}
                >
                  Cancel
                </button>
                <button type="submit" className={styles.btnPrimary} disabled={pending}>
                  {pending ? "Adding…" : `Add ${singular}`}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </>
  );
}
