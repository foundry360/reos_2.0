"use client";

import Link from "next/link";
import type { ReactNode } from "react";
import {
  buildOpportunitiesListQuery,
  type OpportunitiesLayout,
  type OpportunitiesListParams,
} from "@/lib/opportunities/opportunities-list-params";
import styles from "@/components/shell/shell.module.css";

function IconList() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path
        d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function IconKanban() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <rect x="3" y="4" width="5" height="16" rx="1.5" stroke="currentColor" strokeWidth="2" />
      <rect x="10" y="4" width="5" height="10" rx="1.5" stroke="currentColor" strokeWidth="2" />
      <rect x="17" y="4" width="4" height="13" rx="1.5" stroke="currentColor" strokeWidth="2" />
    </svg>
  );
}

interface OpportunitiesLayoutToggleProps {
  params: OpportunitiesListParams;
}

const OPTIONS: { id: OpportunitiesLayout; label: string; icon: ReactNode }[] = [
  { id: "list", label: "List view", icon: <IconList /> },
  { id: "kanban", label: "Kanban view", icon: <IconKanban /> },
];

export function OpportunitiesLayoutToggle({ params }: OpportunitiesLayoutToggleProps) {
  return (
    <div className={styles.layoutToggle} role="group" aria-label="Layout">
      {OPTIONS.map((option) => {
        const active = params.layout === option.id;
        const href = `/opportunities${buildOpportunitiesListQuery({
          ...params,
          layout: option.id,
          page: 1,
        })}`;

        return (
          <Link
            key={option.id}
            href={href}
            className={`${styles.layoutToggleBtn} ${active ? styles.layoutToggleBtnActive : ""}`}
            aria-label={option.label}
            aria-pressed={active}
            title={option.label}
          >
            {option.icon}
          </Link>
        );
      })}
    </div>
  );
}
