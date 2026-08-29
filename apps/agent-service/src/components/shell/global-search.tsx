"use client";

import Link from "next/link";
import { useEffect, useId, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { searchTenantGlobalAction } from "@/lib/crm/global-search-actions";
import type { GlobalSearchResult } from "@/lib/crm/global-search";
import { ActivityTypeIcon } from "./activity-date-feed";
import styles from "./shell.module.css";

const TYPE_LABEL: Record<GlobalSearchResult["type"], string> = {
  page: "Page",
  lead: "Lead",
  contact: "Contact",
  opportunity: "Opportunity",
  task: "Task",
};

export function GlobalSearch() {
  const router = useRouter();
  const listId = useId();
  const rootRef = useRef<HTMLDivElement>(null);
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);
  const [results, setResults] = useState<GlobalSearchResult[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function closeSearch() {
    setOpen(false);
    setQuery("");
    setResults([]);
    setError(null);
    setActiveIndex(0);
  }

  useEffect(() => {
    function onDocClick(e: MouseEvent) {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) {
        closeSearch();
      }
    }
    document.addEventListener("mousedown", onDocClick);
    return () => document.removeEventListener("mousedown", onDocClick);
  }, []);

  useEffect(() => {
    const trimmed = query.trim();
    if (trimmed.length < 1) {
      setResults([]);
      setError(null);
      setActiveIndex(0);
      return;
    }

    const handle = window.setTimeout(() => {
      startTransition(async () => {
        const result = await searchTenantGlobalAction(trimmed);
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
    }, 200);

    return () => window.clearTimeout(handle);
  }, [query]);

  function goTo(href: string) {
    closeSearch();
    router.push(href);
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (!open && (e.key === "ArrowDown" || e.key === "Enter") && results.length > 0) {
      setOpen(true);
      return;
    }

    if (e.key === "Escape") {
      closeSearch();
      e.currentTarget.blur();
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
      e.preventDefault();
      const selected = results[activeIndex];
      if (selected) goTo(selected.href);
    }
  }

  return (
    <div className={styles.globalSearch} ref={rootRef}>
      <div className={styles.globalSearchField}>
        <span className={styles.globalSearchIcon} aria-hidden>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none">
            <circle cx="11" cy="11" r="7" stroke="currentColor" strokeWidth="2" />
            <path d="M20 20l-3.5-3.5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
          </svg>
        </span>
        <input
          className={styles.globalSearchInput}
          type="search"
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setOpen(true);
          }}
          onFocus={() => {
            if (query.trim().length > 0) setOpen(true);
          }}
          onKeyDown={onKeyDown}
          placeholder="Search leads, contacts, opportunities…"
          aria-label="Global search"
          aria-expanded={open}
          aria-controls={listId}
          aria-autocomplete="list"
          role="combobox"
          autoComplete="off"
        />
        {pending && <span className={styles.globalSearchSpinner} aria-hidden />}
      </div>

      {open && query.trim().length > 0 && (
        <div className={styles.globalSearchDropdown} id={listId} role="listbox">
          {error && <p className={styles.globalSearchEmpty}>{error}</p>}
          {!error && results.length === 0 && !pending && (
            <p className={styles.globalSearchEmpty}>No matches for “{query.trim()}”.</p>
          )}
          {results.map((result, index) => (
            <Link
              key={`${result.type}-${result.id}`}
              href={result.href}
              className={`${styles.globalSearchItem} ${
                index === activeIndex ? styles.globalSearchItemActive : ""
              }`}
              role="option"
              aria-selected={index === activeIndex}
              onMouseEnter={() => setActiveIndex(index)}
              onClick={() => {
                closeSearch();
              }}
            >
              <ActivityTypeIcon type={result.type} />
              <span className={styles.globalSearchItemBody}>
                <span className={styles.globalSearchItemTitle}>{result.title}</span>
                <span className={styles.globalSearchItemMeta}>
                  <span className={styles.globalSearchItemType}>{TYPE_LABEL[result.type]}</span>
                  {result.subtitle ? (
                    <span className={styles.globalSearchItemSubtitle}>{result.subtitle}</span>
                  ) : null}
                </span>
              </span>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
