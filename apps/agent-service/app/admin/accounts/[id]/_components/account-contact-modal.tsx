"use client";

import { useEffect, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import {
  createTenantAdditionalContactAction,
  updateTenantAdditionalContactAction,
  updateTenantContactAction,
} from "@/lib/admin/tenant-config-actions";
import { ExtensionSafeInput } from "@/components/shell/extension-safe-input";
import { PhoneInput } from "@/components/shell/phone-input";
import type { TenantConfig, TenantContact } from "@/lib/admin/tenant-config";
import styles from "@/components/shell/shell.module.css";

export type ContactModalMode =
  | { type: "add" }
  | { type: "primary" }
  | { type: "additional"; contact: TenantContact };

interface AccountContactModalProps {
  tenant: TenantConfig;
  mode: ContactModalMode;
  onClose: () => void;
}

function readPrimaryValues(tenant: TenantConfig) {
  return {
    firstName: tenant.principalFirstName ?? "",
    lastName: tenant.principalLastName ?? "",
    email: tenant.email ?? "",
    phoneE164: tenant.primaryPhone ?? "",
    website: tenant.website ?? "",
    title: "Primary",
  };
}

function readAdditionalValues(contact: TenantContact) {
  return {
    firstName: contact.firstName,
    lastName: contact.lastName,
    email: contact.email ?? "",
    phoneE164: contact.phoneE164 ?? "",
    website: contact.website ?? "",
    title: contact.title ?? "",
  };
}

export function AccountContactModal({ tenant, mode, onClose }: AccountContactModalProps) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const initialValues =
    mode.type === "additional"
      ? readAdditionalValues(mode.contact)
      : mode.type === "primary"
        ? readPrimaryValues(tenant)
        : {
            firstName: "",
            lastName: "",
            email: "",
            phoneE164: "",
            website: "",
            title: "",
          };

  const [firstName, setFirstName] = useState(initialValues.firstName);
  const [lastName, setLastName] = useState(initialValues.lastName);
  const [email, setEmail] = useState(initialValues.email);
  const [phoneE164, setPhoneE164] = useState(initialValues.phoneE164);
  const [website, setWebsite] = useState(initialValues.website);
  const [title, setTitle] = useState(initialValues.title);

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape" && !pending) onClose();
    }

    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [onClose, pending]);

  useEffect(() => {
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = "";
    };
  }, []);

  const modalTitle =
    mode.type === "add"
      ? "Add contact"
      : mode.type === "primary"
        ? "Edit primary contact"
        : "Edit contact";

  const modalSubtitle =
    mode.type === "add"
      ? "Add another contact for this account."
      : mode.type === "primary"
        ? "Update the primary account contact."
        : "Update contact details.";

  function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);

    const formData = new FormData(e.currentTarget);
    formData.set("tenantId", tenant.id);

    startTransition(async () => {
      let result;
      if (mode.type === "primary") {
        formData.set("principalFirstName", firstName);
        formData.set("principalLastName", lastName);
        result = await updateTenantContactAction(formData);
      } else if (mode.type === "additional") {
        formData.set("contactId", mode.contact.id);
        result = await updateTenantAdditionalContactAction(formData);
      } else {
        result = await createTenantAdditionalContactAction(formData);
      }

      if (!result.ok) {
        setError(result.error ?? "Could not save contact.");
        return;
      }

      onClose();
      router.refresh();
    });
  }

  return (
    <div className={styles.modalOverlay} onClick={() => !pending && onClose()}>
      <div
        className={styles.modalPanel}
        role="dialog"
        aria-modal="true"
        aria-labelledby="account-contact-title"
        onClick={(e) => e.stopPropagation()}
      >
        <div className={styles.modalHeader}>
          <div>
            <h2 id="account-contact-title" className={styles.modalTitle}>
              {modalTitle}
            </h2>
            <p className={styles.modalSubtitle}>{modalSubtitle}</p>
          </div>
          <button
            type="button"
            className={styles.iconBtn}
            aria-label="Close"
            onClick={onClose}
            disabled={pending}
          >
            ×
          </button>
        </div>

        <form className={styles.modalBody} onSubmit={handleSubmit}>
          {error && <p className={styles.error}>{error}</p>}

          <div className={styles.fieldRow}>
            <div className={styles.field}>
              <label className={styles.label} htmlFor="contact-first-name">
                First Name
              </label>
              <input
                id="contact-first-name"
                name="firstName"
                className={styles.input}
                value={firstName}
                onChange={(e) => setFirstName(e.target.value)}
                required
                disabled={pending}
              />
            </div>
            <div className={styles.field}>
              <label className={styles.label} htmlFor="contact-last-name">
                Last Name
              </label>
              <input
                id="contact-last-name"
                name="lastName"
                className={styles.input}
                value={lastName}
                onChange={(e) => setLastName(e.target.value)}
                required
                disabled={pending}
              />
            </div>
          </div>

          {mode.type !== "primary" && (
            <div className={styles.field}>
              <label className={styles.label} htmlFor="contact-title">
                Title
              </label>
              <input
                id="contact-title"
                name="title"
                className={styles.input}
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder="Billing, Operations, etc."
                disabled={pending}
              />
            </div>
          )}

          <div className={styles.field}>
            <label className={styles.label} htmlFor="contact-email">
              Email
            </label>
            <ExtensionSafeInput
              id="contact-email"
              name="email"
              type="email"
              className={styles.input}
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="contact@example.com"
              disabled={pending}
            />
          </div>

          <div className={styles.field}>
            <label className={styles.label} htmlFor="contact-phone">
              Phone
            </label>
            <PhoneInput
              id="contact-phone"
              name="phoneE164"
              className={styles.input}
              value={phoneE164}
              disabled={pending}
            />
          </div>

          <div className={styles.field}>
            <label className={styles.label} htmlFor="contact-website">
              Website
            </label>
            <ExtensionSafeInput
              id="contact-website"
              name="website"
              type="url"
              className={styles.input}
              value={website}
              onChange={(e) => setWebsite(e.target.value)}
              placeholder="https://example.com"
              disabled={pending}
            />
          </div>

          <div className={styles.modalFooter}>
            <button
              type="button"
              className={styles.btnSecondary}
              onClick={onClose}
              disabled={pending}
            >
              Cancel
            </button>
            <button type="submit" className={styles.btnPrimary} disabled={pending}>
              {pending ? "Saving…" : mode.type === "add" ? "Add contact" : "Save contact"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

export function formatContactName(
  firstName: string | null | undefined,
  lastName: string | null | undefined,
): string {
  const name = [firstName, lastName].filter(Boolean).join(" ").trim();
  return name ? name : "Unnamed contact";
}
