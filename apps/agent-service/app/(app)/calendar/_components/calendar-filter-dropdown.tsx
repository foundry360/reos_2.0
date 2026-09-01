"use client";

import { useEffect, useId, useRef, useState } from "react";
import shellStyles from "@/components/shell/shell.module.css";
import type { CalendarEventKind } from "@/lib/calendar/calendar-types";
import {
  CALENDAR_EVENT_COLORS,
  CALENDAR_EVENT_KIND_LABELS,
  CALENDAR_EVENT_KINDS,
} from "@/lib/calendar/calendar-types";
import styles from "./calendar.module.css";

interface CalendarFilterDropdownProps {
  filters: CalendarEventKind[];
  onChange: (filters: CalendarEventKind[]) => void;
}

function filterLabel(filters: CalendarEventKind[]): string {
  if (filters.length === CALENDAR_EVENT_KINDS.length) return "All events";
  if (filters.length === 0) return "No events";
  if (filters.length === 1) return CALENDAR_EVENT_KIND_LABELS[filters[0]];
  if (filters.length === 2) {
    return filters.map((kind) => CALENDAR_EVENT_KIND_LABELS[kind]).join(", ");
  }
  return `${filters.length} types`;
}

function IconChevron() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden="true">
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

function IconCheck() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path
        d="M5 12l5 5 9-9"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export function CalendarFilterDropdown({ filters, onChange }: CalendarFilterDropdownProps) {
  const controlId = useId();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const activeSet = new Set(filters);

  useEffect(() => {
    if (!open) return;

    function onDocClick(event: MouseEvent) {
      if (ref.current && !ref.current.contains(event.target as Node)) {
        setOpen(false);
      }
    }

    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") setOpen(false);
    }

    document.addEventListener("mousedown", onDocClick);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onDocClick);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  function toggleKind(kind: CalendarEventKind) {
    const next = new Set(activeSet);
    if (next.has(kind)) next.delete(kind);
    else next.add(kind);
    const ordered = CALENDAR_EVENT_KINDS.filter((value) => next.has(value));
    onChange(ordered.length > 0 ? ordered : [...CALENDAR_EVENT_KINDS]);
  }

  return (
    <div
      ref={ref}
      className={`${styles.viewDropdown} ${shellStyles.dropdownSelect} ${shellStyles.dropdownSelectInline} ${shellStyles.calendarViewDropdown} ${shellStyles.calendarFilterDropdown}`}
    >
      <button
        id={controlId}
        type="button"
        className={`${shellStyles.dropdownSelectTrigger} ${shellStyles.dropdownSelectTriggerCompact} ${open ? shellStyles.dropdownSelectTriggerOpen : ""}`}
        aria-label="Event types"
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => setOpen((current) => !current)}
      >
        <span className={shellStyles.dropdownSelectValue}>{filterLabel(filters)}</span>
        <span className={shellStyles.dropdownSelectChevron}>
          <IconChevron />
        </span>
      </button>

      {open ? (
        <div
          className={shellStyles.dropdownSelectMenu}
          role="listbox"
          aria-labelledby={controlId}
          aria-multiselectable
        >
          {CALENDAR_EVENT_KINDS.map((kind) => {
            const active = activeSet.has(kind);
            return (
              <button
                key={kind}
                type="button"
                role="option"
                aria-selected={active}
                className={`${shellStyles.dropdownOption} ${active ? shellStyles.dropdownOptionActive : ""}`}
                onClick={() => toggleKind(kind)}
              >
                <span className={shellStyles.dropdownOptionMain}>
                  <span
                    className={shellStyles.optionColorDot}
                    style={{ backgroundColor: CALENDAR_EVENT_COLORS[kind] }}
                  />
                  <span>{CALENDAR_EVENT_KIND_LABELS[kind]}</span>
                </span>
                {active ? (
                  <span className={shellStyles.dropdownOptionCheck}>
                    <IconCheck />
                  </span>
                ) : null}
              </button>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}
