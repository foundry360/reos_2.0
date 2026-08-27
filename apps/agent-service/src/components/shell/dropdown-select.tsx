"use client";

import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import styles from "./shell.module.css";

export interface DropdownSelectOption {
  value: string;
  label: string;
  leading?: React.ReactNode;
}

interface DropdownSelectProps {
  id?: string;
  name?: string;
  value: string;
  onChange: (value: string) => void;
  options: DropdownSelectOption[];
  placeholder?: string;
  disabled?: boolean;
  variant?: "field" | "compact" | "inline";
  ariaLabel?: string;
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

export function DropdownSelect({
  id,
  name,
  value,
  onChange,
  options,
  placeholder = "Select…",
  disabled = false,
  variant = "field",
  ariaLabel,
}: DropdownSelectProps) {
  const generatedId = useId();
  const controlId = id ?? generatedId;
  const [open, setOpen] = useState(false);
  const [menuPlacement, setMenuPlacement] = useState<"down" | "up">("down");
  const ref = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  const selected = options.find((option) => option.value === value);
  const displayLabel = selected?.label ?? placeholder;

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

  useLayoutEffect(() => {
    if (!open) {
      setMenuPlacement("down");
      return;
    }

    const root = ref.current;
    const menu = menuRef.current;
    if (!root || !menu) return;

    const trigger = root.querySelector("button");
    if (!trigger) return;

    const triggerRect = trigger.getBoundingClientRect();
    const menuHeight = menu.offsetHeight;
    const gap = 8;
    const clipParent = findClipParent(root);
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
  }, [open, options.length]);

  const triggerClass = [
    styles.dropdownSelectTrigger,
    variant === "compact" ? styles.dropdownSelectTriggerCompact : "",
    variant === "inline" ? styles.dropdownSelectTriggerInline : "",
    open ? styles.dropdownSelectTriggerOpen : "",
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <div
      className={`${styles.dropdownSelect} ${variant === "inline" ? styles.dropdownSelectInline : ""}`}
      ref={ref}
    >
      <button
        id={controlId}
        type="button"
        className={triggerClass}
        aria-label={ariaLabel}
        aria-haspopup="listbox"
        aria-expanded={open}
        disabled={disabled}
        onClick={() => setOpen((current) => !current)}
      >
        <span className={styles.dropdownSelectValue}>
          {selected?.leading ? (
            <span className={styles.dropdownSelectValueInner}>
              {selected.leading}
              <span className={styles.dropdownSelectValueLabel}>{displayLabel}</span>
            </span>
          ) : (
            displayLabel
          )}
        </span>
        <span className={styles.dropdownSelectChevron}>
          <IconChevron />
        </span>
      </button>

      {open && (
        <div
          ref={menuRef}
          className={`${styles.dropdownSelectMenu} ${
            menuPlacement === "up" ? styles.dropdownSelectMenuUp : ""
          }`}
          role="listbox"
          aria-labelledby={controlId}
        >
          {options.map((option) => {
            const active = option.value === value;
            return (
              <button
                key={option.value || "__empty__"}
                type="button"
                role="option"
                aria-selected={active}
                className={`${styles.dropdownOption} ${active ? styles.dropdownOptionActive : ""}`}
                onClick={() => {
                  onChange(option.value);
                  setOpen(false);
                }}
              >
                <span className={styles.dropdownOptionMain}>
                  {option.leading}
                  <span>{option.label}</span>
                </span>
                {active && (
                  <span className={styles.dropdownOptionCheck}>
                    <IconCheck />
                  </span>
                )}
              </button>
            );
          })}
        </div>
      )}

      {name && <input type="hidden" name={name} value={value} />}
    </div>
  );
}

interface DropdownOptionListProps {
  value: string;
  onChange: (value: string) => void;
  options: DropdownSelectOption[];
}

export function DropdownOptionList({ value, onChange, options }: DropdownOptionListProps) {
  return (
    <div className={styles.dropdownOptionList} role="listbox">
      {options.map((option) => {
        const active = option.value === value;
        return (
          <button
            key={option.value || "__empty__"}
            type="button"
            role="option"
            aria-selected={active}
            className={`${styles.dropdownOption} ${active ? styles.dropdownOptionActive : ""}`}
            onClick={() => onChange(option.value)}
          >
            <span>{option.label}</span>
            {active && (
              <span className={styles.dropdownOptionCheck}>
                <IconCheck />
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}
