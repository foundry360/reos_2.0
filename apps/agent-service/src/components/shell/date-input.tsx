"use client";

import {
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type InputHTMLAttributes,
} from "react";
import styles from "./shell.module.css";

type DateInputProps = Omit<InputHTMLAttributes<HTMLInputElement>, "type" | "onChange"> & {
  value?: string;
  onChange?: (event: ChangeEvent<HTMLInputElement>) => void;
};

const WEEKDAYS = ["Su", "Mo", "Tu", "We", "Th", "Fr", "Sa"] as const;

function parseIsoDate(value: string): Date | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const [year, month, day] = value.split("-").map(Number);
  const date = new Date(year, month - 1, day);
  if (
    date.getFullYear() !== year ||
    date.getMonth() !== month - 1 ||
    date.getDate() !== day
  ) {
    return null;
  }
  return date;
}

function toIsoDate(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function formatDisplayDate(value: string): string {
  const date = parseIsoDate(value);
  if (!date) return "";
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  }).format(date);
}

function startOfMonth(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), 1);
}

function addMonths(date: Date, amount: number): Date {
  return new Date(date.getFullYear(), date.getMonth() + amount, 1);
}

function sameDay(a: Date, b: Date): boolean {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}

function buildCalendarDays(month: Date): Date[] {
  const first = startOfMonth(month);
  const startOffset = first.getDay();
  const gridStart = new Date(first);
  gridStart.setDate(first.getDate() - startOffset);

  return Array.from({ length: 42 }, (_, index) => {
    const day = new Date(gridStart);
    day.setDate(gridStart.getDate() + index);
    return day;
  });
}

function findClipParent(element: HTMLElement): HTMLElement | null {
  let node: HTMLElement | null = element.parentElement;
  while (node) {
    const { overflow, overflowX, overflowY } = getComputedStyle(node);
    if (
      [overflow, overflowX, overflowY].some(
        (value) => value === "auto" || value === "scroll" || value === "hidden",
      )
    ) {
      return node;
    }
    node = node.parentElement;
  }
  return null;
}

function IconCalendar() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <rect x="3" y="5" width="18" height="16" rx="2" stroke="currentColor" strokeWidth="2" />
      <path
        d="M16 3v4M8 3v4M3 11h18"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
      />
    </svg>
  );
}

function IconChevron({ direction }: { direction: "left" | "right" }) {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path
        d={direction === "left" ? "M15 18l-6-6 6-6" : "M9 18l6-6-6-6"}
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export function DateInput({
  id,
  name,
  value = "",
  onChange,
  disabled = false,
  className,
  "aria-label": ariaLabel,
}: DateInputProps) {
  const generatedId = useId();
  const controlId = id ?? generatedId;
  const stringValue = typeof value === "string" ? value : "";
  const selectedDate = parseIsoDate(stringValue);
  const [open, setOpen] = useState(false);
  const [menuPlacement, setMenuPlacement] = useState<"down" | "up">("down");
  const [visibleMonth, setVisibleMonth] = useState(() =>
    startOfMonth(selectedDate ?? new Date()),
  );
  const rootRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  const empty = !stringValue;
  const displayLabel = empty ? "Select a date" : formatDisplayDate(stringValue);
  const today = useMemo(() => {
    const now = new Date();
    return new Date(now.getFullYear(), now.getMonth(), now.getDate());
  }, [open]);
  const days = useMemo(() => buildCalendarDays(visibleMonth), [visibleMonth]);
  const monthLabel = new Intl.DateTimeFormat("en-US", {
    month: "long",
    year: "numeric",
  }).format(visibleMonth);

  useEffect(() => {
    if (!open) return;
    setVisibleMonth(startOfMonth(parseIsoDate(stringValue) ?? new Date()));
  }, [open, stringValue]);

  useEffect(() => {
    if (!open) return;

    function onDocClick(event: MouseEvent) {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) {
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

  useLayoutEffect(() => {
    if (!open || !rootRef.current || !panelRef.current) return;

    const triggerRect = rootRef.current.getBoundingClientRect();
    const menuHeight = panelRef.current.offsetHeight;
    const gap = 8;
    const clipParent = findClipParent(rootRef.current);
    const boundaryBottom = clipParent
      ? clipParent.getBoundingClientRect().bottom
      : window.innerHeight;
    const boundaryTop = clipParent ? clipParent.getBoundingClientRect().top : 0;
    const spaceBelow = boundaryBottom - triggerRect.bottom - gap;
    const spaceAbove = triggerRect.top - boundaryTop - gap;

    if (spaceBelow < menuHeight && spaceAbove >= menuHeight) {
      setMenuPlacement("up");
      return;
    }
    if (spaceBelow < menuHeight && spaceAbove > spaceBelow) {
      setMenuPlacement("up");
      return;
    }
    setMenuPlacement("down");
  }, [open, visibleMonth]);

  function emitChange(next: string) {
    if (!onChange) return;
    const target = { value: next, name: name ?? "" };
    onChange({
      target,
      currentTarget: target,
    } as ChangeEvent<HTMLInputElement>);
  }

  function selectDate(date: Date) {
    emitChange(toIsoDate(date));
    setOpen(false);
  }

  function clearDate() {
    emitChange("");
    setOpen(false);
  }

  function selectToday() {
    selectDate(today);
  }

  return (
    <div className={`${styles.datePicker} ${className ?? ""}`} ref={rootRef}>
      {name ? <input type="hidden" name={name} value={stringValue} /> : null}
      <button
        id={controlId}
        type="button"
        className={`${styles.datePickerTrigger} ${empty ? styles.datePickerTriggerEmpty : ""} ${
          open ? styles.datePickerTriggerOpen : ""
        }`}
        aria-label={ariaLabel ?? "Choose date"}
        aria-haspopup="dialog"
        aria-expanded={open}
        disabled={disabled}
        onClick={() => setOpen((current) => !current)}
      >
        <span className={styles.datePickerValue}>{displayLabel}</span>
        <span className={styles.datePickerIcon}>
          <IconCalendar />
        </span>
      </button>

      {open ? (
        <div
          ref={panelRef}
          className={`${styles.datePickerPanel} ${
            menuPlacement === "up" ? styles.datePickerPanelUp : ""
          }`}
          role="dialog"
          aria-label="Choose date"
        >
          <div className={styles.datePickerHeader}>
            <button
              type="button"
              className={styles.datePickerNavBtn}
              aria-label="Previous month"
              onClick={() => setVisibleMonth((month) => addMonths(month, -1))}
            >
              <IconChevron direction="left" />
            </button>
            <p className={styles.datePickerMonthLabel}>{monthLabel}</p>
            <button
              type="button"
              className={styles.datePickerNavBtn}
              aria-label="Next month"
              onClick={() => setVisibleMonth((month) => addMonths(month, 1))}
            >
              <IconChevron direction="right" />
            </button>
          </div>

          <div className={styles.datePickerWeekdays} aria-hidden="true">
            {WEEKDAYS.map((day) => (
              <span key={day} className={styles.datePickerWeekday}>
                {day}
              </span>
            ))}
          </div>

          <div className={styles.datePickerGrid}>
            {days.map((day) => {
              const inMonth = day.getMonth() === visibleMonth.getMonth();
              const isSelected = selectedDate ? sameDay(day, selectedDate) : false;
              const isToday = sameDay(day, today);
              return (
                <button
                  key={toIsoDate(day)}
                  type="button"
                  className={[
                    styles.datePickerDay,
                    inMonth ? "" : styles.datePickerDayMuted,
                    isSelected ? styles.datePickerDaySelected : "",
                    isToday && !isSelected ? styles.datePickerDayToday : "",
                  ]
                    .filter(Boolean)
                    .join(" ")}
                  onClick={() => selectDate(day)}
                >
                  {day.getDate()}
                </button>
              );
            })}
          </div>

          <div className={styles.datePickerFooter}>
            <button type="button" className={styles.datePickerFooterBtn} onClick={clearDate}>
              Clear
            </button>
            <button type="button" className={styles.datePickerFooterBtn} onClick={selectToday}>
              Today
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
