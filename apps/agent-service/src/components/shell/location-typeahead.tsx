"use client";

import { useEffect, useId, useRef, useState, useTransition } from "react";
import { searchPlacesAction } from "@/lib/places/actions";
import { formatPlaceDisplay, type PlaceSuggestion } from "@/lib/places/types";
import styles from "./shell.module.css";

interface LocationTypeaheadProps {
  id?: string;
  value: string;
  onChange: (value: string) => void;
  disabled?: boolean;
  placeholder?: string;
  "aria-label"?: string;
}

export function LocationTypeahead({
  id,
  value,
  onChange,
  disabled = false,
  placeholder = "Office, listing address, or Zoom…",
  "aria-label": ariaLabel = "Location",
}: LocationTypeaheadProps) {
  const listId = useId();
  const rootRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);
  const [results, setResults] = useState<PlaceSuggestion[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const skipSearchRef = useRef(false);

  useEffect(() => {
    function onDocClick(e: MouseEvent) {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener("mousedown", onDocClick);
    return () => document.removeEventListener("mousedown", onDocClick);
  }, []);

  useEffect(() => {
    if (skipSearchRef.current) {
      skipSearchRef.current = false;
      return;
    }

    const trimmed = value.trim();
    if (trimmed.length < 2) {
      setResults([]);
      setError(null);
      setActiveIndex(0);
      return;
    }

    const handle = window.setTimeout(() => {
      startTransition(async () => {
        const result = await searchPlacesAction(trimmed);
        if (!result.ok) {
          setError(result.error);
          setResults([]);
          return;
        }
        setError(null);
        setResults(result.results);
        setActiveIndex(0);
        setOpen(true);
      });
    }, 250);

    return () => window.clearTimeout(handle);
  }, [value]);

  function selectSuggestion(suggestion: PlaceSuggestion) {
    skipSearchRef.current = true;
    onChange(formatPlaceDisplay(suggestion));
    setResults([]);
    setOpen(false);
    setError(null);
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === "Escape") {
      setOpen(false);
      return;
    }

    if (!open || results.length === 0) return;

    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActiveIndex((index) => (index + 1) % results.length);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActiveIndex((index) => (index - 1 + results.length) % results.length);
    } else if (e.key === "Enter") {
      const selected = results[activeIndex];
      if (selected) {
        e.preventDefault();
        selectSuggestion(selected);
      }
    }
  }

  return (
    <div className={styles.locationTypeahead} ref={rootRef}>
      <div className={styles.locationTypeaheadField}>
        <input
          id={id}
          className={styles.input}
          type="text"
          value={value}
          onChange={(e) => {
            onChange(e.target.value);
            setOpen(true);
          }}
          onFocus={() => {
            if (results.length > 0 || value.trim().length >= 2) setOpen(true);
          }}
          onKeyDown={onKeyDown}
          placeholder={placeholder}
          aria-label={ariaLabel}
          aria-expanded={open}
          aria-controls={listId}
          aria-autocomplete="list"
          role="combobox"
          autoComplete="off"
          disabled={disabled}
        />
        {pending ? (
          <span className={styles.locationTypeaheadSpinner} aria-hidden />
        ) : null}
      </div>

      {open && value.trim().length >= 2 ? (
        <div className={styles.locationTypeaheadDropdown} id={listId} role="listbox">
          {error ? <p className={styles.locationTypeaheadEmpty}>{error}</p> : null}
          {!error && results.length === 0 && !pending ? (
            <p className={styles.locationTypeaheadEmpty}>
              No places found — keep typing or enter a custom location.
            </p>
          ) : null}
          {results.map((result, index) => (
            <button
              key={result.id}
              type="button"
              className={`${styles.locationTypeaheadItem} ${
                index === activeIndex ? styles.locationTypeaheadItemActive : ""
              }`}
              role="option"
              aria-selected={index === activeIndex}
              onMouseEnter={() => setActiveIndex(index)}
              onClick={() => selectSuggestion(result)}
            >
              <span className={styles.locationTypeaheadItemTitle}>{result.label}</span>
              {result.secondary ? (
                <span className={styles.locationTypeaheadItemMeta}>{result.secondary}</span>
              ) : null}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}
