"use client";

import { useState } from "react";
import type { PersonKind } from "@/lib/crm/person-kind";
import { PersonActivityModal } from "./person-activity-modal";
import styles from "@/components/shell/shell.module.css";

function IconTimeline() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <rect x="3.5" y="3.5" width="17" height="17" rx="3" stroke="currentColor" strokeWidth="1.75" />
      <circle cx="8" cy="8.5" r="1.15" fill="currentColor" />
      <path d="M11 8.5h6" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" />
      <circle cx="8" cy="12" r="1.15" fill="currentColor" />
      <path d="M11 12h6" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" />
      <circle cx="8" cy="15.5" r="1.15" fill="currentColor" />
      <path d="M11 15.5h6" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" />
    </svg>
  );
}

interface PersonActivityTriggerProps {
  personName: string;
  kind?: PersonKind;
}

export function PersonActivityTrigger({
  personName,
  kind = "lead",
}: PersonActivityTriggerProps) {
  const [open, setOpen] = useState(false);

  function handleClick(e: React.MouseEvent) {
    e.preventDefault();
    e.stopPropagation();
    setOpen(true);
  }

  return (
    <>
      <button
        type="button"
        className={styles.timelineIconBtn}
        aria-label={`View activity for ${personName}`}
        title="Activity timeline"
        onClick={handleClick}
      >
        <IconTimeline />
      </button>
      {open && (
        <PersonActivityModal
          personName={personName}
          kind={kind}
          onClose={() => setOpen(false)}
        />
      )}
    </>
  );
}
