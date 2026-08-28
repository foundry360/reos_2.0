"use client";

import { useEffect, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { updateLeadAction } from "@/lib/crm/crm-actions";
import { personSingularTitle } from "@/lib/crm/person-kind";
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

export function PersonAboutCard({ person }: { person: PersonDetailData }) {
  const router = useRouter();
  const singular = personSingularTitle(person.kind);
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

  useEffect(() => {
    if (editing) return;
    setFirstName(person.firstName);
    setLastName(person.lastName);
    setEmail(person.email ?? "");
    setPhone(person.phone ?? "");
    setStatus(resolveStatus(person.leadStatus));
  }, [person, editing]);

  function startEdit() {
    setError(null);
    setSuccess(false);
    setFirstName(person.firstName);
    setLastName(person.lastName);
    setEmail(person.email ?? "");
    setPhone(person.phone ?? "");
    setStatus(resolveStatus(person.leadStatus));
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
  }

  function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
    setSuccess(false);
    const formData = new FormData(e.currentTarget);
    formData.set("leadId", person.id);
    formData.set("status", status);
    formData.set("firstName", firstName);
    formData.set("lastName", lastName);
    formData.set("email", email);

    startTransition(async () => {
      const result = await updateLeadAction(formData);
      if (!result.ok) {
        setError(result.error ?? `Could not update ${singular.toLowerCase()}.`);
        return;
      }
      setSuccess(true);
      setEditing(false);
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
          <span>About this {singular.toLowerCase()}</span>
          <AccordionChevron open={open} />
        </button>
        {!editing && (
          <IconEdit onClick={startEdit} label={`Edit ${singular.toLowerCase()} details`} />
        )}
      </div>

      {open &&
        (!editing ? (
          <div className={styles.personSideCardBody}>
            <PropertyRow label="First name" value={person.firstName || displayValue(null)} />
            <PropertyRow label="Last name" value={person.lastName || displayValue(null)} />
            <PropertyRow label="Email" value={person.email ?? displayValue(null)} />
            <PropertyRow label="Phone number" value={person.phone ?? displayValue(null)} />
            <PropertyRow label="Lead status" value={person.statusLabel} />
            <PropertyRow
              label="Score"
              value={person.score != null ? String(person.score) : displayValue(null)}
            />
            <PropertyRow
              label="Temperature"
              value={person.temperature ?? displayValue(null)}
            />
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

            <EditFormActions pending={pending} onCancel={cancelEdit} />
          </form>
        ))}
    </section>
  );
}
