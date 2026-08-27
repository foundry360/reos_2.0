"use client";

import { useState, type ReactNode } from "react";
import styles from "@/components/shell/shell.module.css";

function AccordionChevron({ open }: { open: boolean }) {
  return (
    <svg
      className={`${styles.integrationAccordionChevron} ${open ? styles.integrationAccordionChevronOpen : ""}`}
      width="16"
      height="16"
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

interface IntegrationAccordionCardProps {
  title: string;
  subtitle: string;
  icon: ReactNode;
  meta?: ReactNode;
  defaultOpen?: boolean;
  children: ReactNode;
}

export function IntegrationAccordionCard({
  title,
  subtitle,
  icon,
  meta,
  defaultOpen = false,
  children,
}: IntegrationAccordionCardProps) {
  const [open, setOpen] = useState(defaultOpen);

  return (
    <section className={styles.integrationCard}>
      <button
        type="button"
        className={styles.integrationAccordionTrigger}
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        <div className={styles.integrationAccordionTriggerMain}>
          <div className={styles.integrationCardHeader}>
            {icon}
            <div>
              <h2 className={styles.integrationCardTitle}>{title}</h2>
              <p className={styles.integrationCardSubtitle}>{subtitle}</p>
            </div>
          </div>
          {meta ? <div className={styles.integrationCardMeta}>{meta}</div> : null}
        </div>
        <AccordionChevron open={open} />
      </button>

      {open ? <div className={styles.integrationAccordionPanel}>{children}</div> : null}
    </section>
  );
}
