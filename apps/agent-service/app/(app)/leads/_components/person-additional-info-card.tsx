"use client";

import { useState } from "react";
import { displayValue } from "@/lib/display-value";
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

/** Qualification / intake fields collected by Concierge. */
export function PersonAdditionalInfoCard({ person }: { person: PersonDetailData }) {
  const [open, setOpen] = useState(true);

  return (
    <section className={styles.personSideCard}>
      <div className={styles.personAboutHeader}>
        <button
          type="button"
          className={styles.personAboutHeaderToggle}
          aria-expanded={open}
          onClick={() => setOpen((value) => !value)}
        >
          <span>Additional Info</span>
          <AccordionChevron open={open} />
        </button>
      </div>

      {open ? (
        <div className={styles.personSideCardBody}>
          <PropertyRow label="Intent" value={person.intent ?? displayValue(null)} />
          <PropertyRow
            label="Area of interest"
            value={person.targetLocation ?? displayValue(null)}
          />
          <PropertyRow
            label="Property type"
            value={person.propertyType ?? displayValue(null)}
          />
          <PropertyRow label="Budget" value={person.budget ?? displayValue(null)} />
          <PropertyRow label="Timeline" value={person.timeline ?? displayValue(null)} />
          <PropertyRow
            label="Financing"
            value={person.financingStatus ?? displayValue(null)}
          />
          <PropertyRow
            label="Must-haves"
            value={person.mustHaves ?? displayValue(null)}
          />
          <PropertyRow
            label="Motivation"
            value={person.motivation ?? displayValue(null)}
          />
          <PropertyRow
            label="Preferences"
            value={person.preferences ?? displayValue(null)}
          />
          <PropertyRow
            label="AI summary"
            value={person.aiSummary ?? displayValue(null)}
          />
        </div>
      ) : null}
    </section>
  );
}
