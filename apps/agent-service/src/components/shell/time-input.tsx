"use client";

import {
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type CSSProperties,
  type InputHTMLAttributes,
} from "react";
import { createPortal } from "react-dom";
import styles from "./shell.module.css";

type TimeInputProps = Omit<InputHTMLAttributes<HTMLInputElement>, "type" | "onChange"> & {
  value?: string;
  onChange?: (event: ChangeEvent<HTMLInputElement>) => void;
  emptyLabel?: string;
  /** Minutes between options. Default 15. */
  stepMinutes?: number;
};

function parseTimeValue(value: string): { hours: number; minutes: number } | null {
  if (!/^\d{2}:\d{2}$/.test(value)) return null;
  const [hours, minutes] = value.split(":").map(Number);
  if (hours < 0 || hours > 23 || minutes < 0 || minutes > 59) return null;
  return { hours, minutes };
}

function formatTimeLabel(value: string): string {
  const parsed = parseTimeValue(value);
  if (!parsed) return "";
  const date = new Date();
  date.setHours(parsed.hours, parsed.minutes, 0, 0);
  return new Intl.DateTimeFormat("en-US", {
    hour: "numeric",
    minute: "2-digit",
  }).format(date);
}

function buildTimeOptions(stepMinutes: number): string[] {
  const step = Math.max(1, Math.min(60, stepMinutes));
  const options: string[] = [];
  for (let minutes = 0; minutes < 24 * 60; minutes += step) {
    const h = Math.floor(minutes / 60);
    const m = minutes % 60;
    options.push(`${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`);
  }
  return options;
}

function IconClock() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="2" />
      <path
        d="M12 7v5l3 2"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export function TimeInput({
  id,
  name,
  value = "",
  onChange,
  disabled = false,
  className,
  emptyLabel = "Select a time",
  stepMinutes = 15,
  "aria-label": ariaLabel,
}: TimeInputProps) {
  const generatedId = useId();
  const controlId = id ?? generatedId;
  const stringValue = typeof value === "string" ? value : "";
  const [open, setOpen] = useState(false);
  const [mounted, setMounted] = useState(false);
  const [panelStyle, setPanelStyle] = useState<CSSProperties>({});
  const rootRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const selectedRef = useRef<HTMLButtonElement>(null);

  const empty = !stringValue;
  const displayLabel = empty ? emptyLabel : formatTimeLabel(stringValue);
  const options = useMemo(() => buildTimeOptions(stepMinutes), [stepMinutes]);

  useEffect(() => {
    setMounted(true);
  }, []);

  useEffect(() => {
    if (!open) return;

    function onDocClick(event: MouseEvent) {
      const target = event.target as Node;
      if (rootRef.current?.contains(target)) return;
      if (panelRef.current?.contains(target)) return;
      setOpen(false);
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

  useLayoutEffect(() => {
    if (!open || !rootRef.current || !panelRef.current) return;

    const gap = 8;
    const margin = 8;
    const triggerRect = rootRef.current.getBoundingClientRect();
    const panelRect = panelRef.current.getBoundingClientRect();
    const menuHeight = panelRect.height || 280;
    const menuWidth = Math.min(
      Math.max(triggerRect.width, 10.5 * 16),
      Math.min(220, window.innerWidth - margin * 2),
    );

    const spaceBelow = window.innerHeight - triggerRect.bottom - gap - margin;
    const spaceAbove = triggerRect.top - gap - margin;
    const placeUp = spaceBelow < menuHeight && spaceAbove > spaceBelow;

    let top = placeUp
      ? triggerRect.top - gap - menuHeight
      : triggerRect.bottom + gap;
    top = Math.max(margin, Math.min(top, window.innerHeight - menuHeight - margin));

    let left = triggerRect.left;
    left = Math.max(margin, Math.min(left, window.innerWidth - menuWidth - margin));

    setPanelStyle({
      position: "fixed",
      top,
      left,
      width: menuWidth,
      zIndex: 400,
    });
  }, [open]);

  useEffect(() => {
    if (!open) return;
    selectedRef.current?.scrollIntoView({ block: "center" });
  }, [open, stringValue]);

  function emitChange(next: string) {
    if (!onChange) return;
    const target = { value: next, name: name ?? "" };
    onChange({
      target,
      currentTarget: target,
    } as ChangeEvent<HTMLInputElement>);
  }

  function selectTime(next: string) {
    emitChange(next);
    setOpen(false);
  }

  function clearTime() {
    emitChange("");
    setOpen(false);
  }

  const panel =
    open && mounted
      ? createPortal(
          <div
            ref={panelRef}
            className={styles.timePickerPanel}
            style={panelStyle}
            role="listbox"
            aria-label="Choose time"
          >
            <div className={styles.timePickerList}>
              {options.map((option) => {
                const selected = option === stringValue;
                return (
                  <button
                    key={option}
                    ref={selected ? selectedRef : undefined}
                    type="button"
                    role="option"
                    aria-selected={selected}
                    className={`${styles.timePickerOption} ${
                      selected ? styles.timePickerOptionSelected : ""
                    }`}
                    onClick={() => selectTime(option)}
                  >
                    {formatTimeLabel(option)}
                  </button>
                );
              })}
            </div>
            <div className={styles.timePickerFooter}>
              <button type="button" className={styles.datePickerFooterBtn} onClick={clearTime}>
                Clear
              </button>
            </div>
          </div>,
          document.body,
        )
      : null;

  return (
    <div className={`${styles.timePicker} ${className ?? ""}`} ref={rootRef}>
      {name ? <input type="hidden" name={name} value={stringValue} /> : null}
      <button
        id={controlId}
        type="button"
        className={`${styles.datePickerTrigger} ${empty ? styles.datePickerTriggerEmpty : ""} ${
          open ? styles.datePickerTriggerOpen : ""
        }`}
        aria-label={ariaLabel ?? "Choose time"}
        aria-haspopup="listbox"
        aria-expanded={open}
        disabled={disabled}
        onClick={() => setOpen((current) => !current)}
      >
        <span className={styles.datePickerValue}>{displayLabel}</span>
        <span className={styles.datePickerIcon}>
          <IconClock />
        </span>
      </button>
      {panel}
    </div>
  );
}
