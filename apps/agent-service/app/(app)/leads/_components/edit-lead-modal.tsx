"use client";

import { useEffect, useState, useTransition } from "react";
import { createPortal } from "react-dom";
import { useRouter } from "next/navigation";
import { updateLeadAction } from "@/lib/crm/crm-actions";
import {
  CONTACT_TYPE_OPTIONS,
  DEFAULT_CONTACT_TYPE,
  isContactType,
  type ContactType,
} from "@/lib/crm/contact-type";
import { personBasePath, personSingularTitle, type PersonKind } from "@/lib/crm/person-kind";
import { LEAD_STATUS_OPTIONS } from "@/lib/leads/lead-status";
import type { LeadRow } from "@/lib/leads/leads-types";
import type { LeadStatus } from "@/lib/coordinator";
import { DropdownSelect } from "@/components/shell/dropdown-select";
import { PhoneInput } from "@/components/shell/phone-input";
import styles from "@/components/shell/shell.module.css";

interface EditLeadModalProps {
  lead: LeadRow;
  kind?: PersonKind;
  onClose: () => void;
}

export function EditLeadModal({ lead, kind = "lead", onClose }: EditLeadModalProps) {
  const router = useRouter();
  const singularTitle = personSingularTitle(kind);
  const isContact = kind === "contact";
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const [firstName, setFirstName] = useState(lead.firstName ?? "");
  const [lastName, setLastName] = useState(lead.lastName ?? "");
  const [email, setEmail] = useState(lead.email ?? "");
  const [status, setStatus] = useState<LeadStatus>(lead.leadStatus);
  const [contactType, setContactType] = useState<ContactType>(
    isContactType(lead.contactType ?? "") ? lead.contactType! : DEFAULT_CONTACT_TYPE,
  );

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape" && !pending) onClose();
    }

    document.addEventListener("keydown", onKeyDown);
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      document.body.style.overflow = "";
    };
  }, [onClose, pending]);

  function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
    const formData = new FormData(e.currentTarget);
    formData.set("leadId", lead.id);
    if (isContact) {
      formData.set("contactType", contactType);
    } else {
      formData.set("status", status);
    }

    startTransition(async () => {
      const result = await updateLeadAction(formData);
      if (!result.ok) {
        setError(result.error ?? `Could not update ${singularTitle.toLowerCase()}.`);
        return;
      }
      onClose();
      if (kind === "lead" && result.kind === "contact") {
        router.push(`${personBasePath("contact")}/${lead.id}`);
        return;
      }
      router.refresh();
    });
  }

  return createPortal(
    <div className={styles.modalOverlay} onClick={() => !pending && onClose()}>
      <div
        className={styles.modalPanel}
        role="dialog"
        aria-modal="true"
        aria-labelledby="edit-lead-title"
        onClick={(e) => e.stopPropagation()}
      >
        <div className={styles.modalHeader}>
          <div>
            <h2 id="edit-lead-title" className={styles.modalTitle}>
              Edit {singularTitle.toLowerCase()}
            </h2>
            <p className={styles.modalSubtitle}>
              Update details for this {singularTitle.toLowerCase()}.
            </p>
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

          <div className={styles.inlineFieldRow}>
            <div className={styles.field}>
              <label className={styles.label} htmlFor="edit-lead-first-name">
                First name
              </label>
              <input
                id="edit-lead-first-name"
                name="firstName"
                className={styles.input}
                value={firstName}
                onChange={(e) => setFirstName(e.target.value)}
                placeholder="Jane"
                disabled={pending}
              />
            </div>
            <div className={styles.field}>
              <label className={styles.label} htmlFor="edit-lead-last-name">
                Last name
              </label>
              <input
                id="edit-lead-last-name"
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
            <label className={styles.label} htmlFor="edit-lead-phone">
              Phone
            </label>
            <PhoneInput
              id="edit-lead-phone"
              name="phone"
              className={styles.input}
              value={lead.phone}
              disabled={pending}
            />
          </div>

          <div className={styles.field}>
            <label className={styles.label} htmlFor="edit-lead-email">
              Email
            </label>
            <input
              id="edit-lead-email"
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
            <label className={styles.label} htmlFor="edit-lead-status">
              {isContact ? "Contact type" : "Status"}
            </label>
            {isContact ? (
              <DropdownSelect
                id="edit-lead-status"
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
                id="edit-lead-status"
                value={status}
                ariaLabel="Lead status"
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
              onClick={onClose}
              disabled={pending}
            >
              Cancel
            </button>
            <button type="submit" className={styles.btnPrimary} disabled={pending}>
              {pending ? "Saving…" : "Save changes"}
            </button>
          </div>
        </form>
      </div>
    </div>,
    document.body,
  );
}
