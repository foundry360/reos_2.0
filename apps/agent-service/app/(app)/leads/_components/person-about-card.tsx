"use client";

import { useEffect, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { updateLeadAction } from "@/lib/crm/crm-actions";
import {
  CONTACT_TYPE_OPTIONS,
  DEFAULT_CONTACT_TYPE,
  isContactType,
  type ContactType,
} from "@/lib/crm/contact-type";
import { personBasePath, personSingularTitle, personTypeFieldLabel } from "@/lib/crm/person-kind";
import type { LeadStatus } from "@/lib/coordinator";
import { isLeadStatus, LEAD_STATUS_OPTIONS } from "@/lib/leads/lead-status";
import { displayValue } from "@/lib/display-value";
import {
  EditFormActions,
  IconEdit,
  InlineEditMessages,
} from "@/components/shell/inline-edit";
import { DropdownSelect } from "@/components/shell/dropdown-select";
import { PhoneInput } from "@/components/shell/phone-input";
import styles from "@/components/shell/shell.module.css";
import type { PersonDetailData } from "../_lib/person-detail-types";

function AccordionChevron({ open }: { open: boolean }) {
  return (
    <svg
      className={`${styles.accordionChevron} ${open ? styles.accordionChevronOpen : ""}`}
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      aria-hidden="true"
    >
      <path
        d="M6 9l6 6 6-6"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function PropertyRow({ label, value }: { label: string; value: string }) {
  return (
    <div className={styles.personPropertyRow}>
      <span className={styles.personPropertyLabel}>{label}</span>
      <span className={styles.personPropertyValue}>{value}</span>
    </div>
  );
}

function resolveStatus(status: string): LeadStatus {
  return isLeadStatus(status) ? status : "New";
}

function resolveContactType(value: string | null | undefined): ContactType {
  if (isContactType(value ?? "")) return value as ContactType;
  return DEFAULT_CONTACT_TYPE;
}

export function PersonAboutCard({ person }: { person: PersonDetailData }) {
  const router = useRouter();
  const singular = personSingularTitle(person.kind);
  const isContact = person.kind === "contact";
  const [open, setOpen] = useState(true);
  const [editing, setEditing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);
  const [pending, startTransition] = useTransition();
  const [firstName, setFirstName] = useState(person.firstName);
  const [lastName, setLastName] = useState(person.lastName);
  const [email, setEmail] = useState(person.email ?? "");
  const [phone, setPhone] = useState(person.phone ?? "");
  const [status, setStatus] = useState<LeadStatus>(resolveStatus(person.leadStatus));
  const [contactType, setContactType] = useState<ContactType>(
    resolveContactType(person.contactType),
  );

  useEffect(() => {
    if (editing) return;
    setFirstName(person.firstName);
    setLastName(person.lastName);
    setEmail(person.email ?? "");
    setPhone(person.phone ?? "");
    setStatus(resolveStatus(person.leadStatus));
    setContactType(resolveContactType(person.contactType));
  }, [person, editing]);

  function startEdit() {
    setError(null);
    setSuccess(false);
    setFirstName(person.firstName);
    setLastName(person.lastName);
    setEmail(person.email ?? "");
    setPhone(person.phone ?? "");
    setStatus(resolveStatus(person.leadStatus));
    setContactType(resolveContactType(person.contactType));
    setOpen(true);
    setEditing(true);
  }

  function cancelEdit() {
    setEditing(false);
    setError(null);
    setSuccess(false);
    setFirstName(person.firstName);
    setLastName(person.lastName);
    setEmail(person.email ?? "");
    setPhone(person.phone ?? "");
    setStatus(resolveStatus(person.leadStatus));
    setContactType(resolveContactType(person.contactType));
  }

  function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
    setSuccess(false);
    const formData = new FormData(e.currentTarget);
    formData.set("leadId", person.id);
    formData.set("firstName", firstName);
    formData.set("lastName", lastName);
    formData.set("email", email);
    if (isContact) {
      formData.set("contactType", contactType);
    } else {
      formData.set("status", status);
    }

    startTransition(async () => {
      const result = await updateLeadAction(formData);
      if (!result.ok) {
        setError(result.error ?? `Could not update ${singular.toLowerCase()}.`);
        return;
      }
      setSuccess(true);
      setEditing(false);
      if (person.kind === "lead" && result.kind === "contact") {
        router.push(`${personBasePath("contact")}/${person.id}`);
        return;
      }
      router.refresh();
    });
  }

  return (
    <section className={styles.personSideCard}>
      <div className={styles.personAboutHeader}>
        <button
          type="button"
          className={styles.personAboutHeaderToggle}
          aria-expanded={open}
          onClick={() => {
            if (editing) return;
            setOpen((value) => !value);
          }}
          disabled={editing}
        >
          <span>{singular} Details</span>
          <AccordionChevron open={open} />
        </button>
        {!editing && (
          <IconEdit onClick={startEdit} label={`Edit ${singular.toLowerCase()} details`} />
        )}
      </div>

      {open &&
        (!editing ? (
          <div className={styles.personSideCardBody}>
            <PropertyRow label="Name" value={person.name || displayValue(null)} />
            <PropertyRow label="Email" value={person.email ?? displayValue(null)} />
            <PropertyRow label="Phone number" value={person.phone ?? displayValue(null)} />
            {isContact ? (
              <PropertyRow
                label={personTypeFieldLabel(person.kind)}
                value={person.contactTypeLabel || displayValue(null)}
              />
            ) : (
              <PropertyRow label="Lead status" value={person.statusLabel} />
            )}
            <PropertyRow label="Opted out" value={person.optedOut ? "Yes" : "No"} />
          </div>
        ) : (
          <form className={styles.personAboutForm} onSubmit={handleSubmit}>
            <InlineEditMessages error={error} success={success} />

            <div className={styles.field}>
              <label className={styles.label} htmlFor="person-about-first-name">
                First name
              </label>
              <input
                id="person-about-first-name"
                name="firstName"
                className={styles.input}
                value={firstName}
                onChange={(e) => setFirstName(e.target.value)}
                disabled={pending}
              />
            </div>

            <div className={styles.field}>
              <label className={styles.label} htmlFor="person-about-last-name">
                Last name
              </label>
              <input
                id="person-about-last-name"
                name="lastName"
                className={styles.input}
                value={lastName}
                onChange={(e) => setLastName(e.target.value)}
                disabled={pending}
              />
            </div>

            <div className={styles.field}>
              <label className={styles.label} htmlFor="person-about-email">
                Email
              </label>
              <input
                id="person-about-email"
                name="email"
                type="email"
                className={styles.input}
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                disabled={pending}
              />
            </div>

            <div className={styles.field}>
              <label className={styles.label} htmlFor="person-about-phone">
                Phone number
              </label>
              <PhoneInput
                id="person-about-phone"
                name="phone"
                className={styles.input}
                value={phone}
                onChange={setPhone}
                disabled={pending}
              />
            </div>

            {isContact ? (
              <div className={styles.field}>
                <label className={styles.label} htmlFor="person-about-contact-type">
                  {personTypeFieldLabel(person.kind)}
                </label>
                <DropdownSelect
                  id="person-about-contact-type"
                  value={contactType}
                  ariaLabel={personTypeFieldLabel(person.kind)}
                  disabled={pending}
                  onChange={(value) => setContactType(value as ContactType)}
                  options={CONTACT_TYPE_OPTIONS.map((option) => ({
                    value: option.value,
                    label: option.label,
                  }))}
                />
              </div>
            ) : (
              <div className={styles.field}>
                <label className={styles.label} htmlFor="person-about-status">
                  Lead status
                </label>
                <DropdownSelect
                  id="person-about-status"
                  value={status}
                  ariaLabel="Lead status"
                  disabled={pending}
                  onChange={(value) => setStatus(value as LeadStatus)}
                  options={LEAD_STATUS_OPTIONS.map((option) => ({
                    value: option.value,
                    label: option.label,
                  }))}
                />
              </div>
            )}

            <EditFormActions pending={pending} onCancel={cancelEdit} />
          </form>
        ))}
    </section>
  );
}
