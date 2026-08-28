"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import {
  buildLeadsListQuery,
  type LeadsListParams,
} from "@/lib/leads/leads-list-params";
import {
  personBasePath,
  personPlural,
  type PersonKind,
} from "@/lib/crm/person-kind";
import { LEAD_STATUS_OPTIONS } from "@/lib/leads/lead-status";
import { DropdownOptionList } from "@/components/shell/dropdown-select";
import styles from "@/components/shell/shell.module.css";

const STATUS_OPTIONS = [
  { value: "all", label: "All statuses" },
  ...LEAD_STATUS_OPTIONS.map((option) => ({
    value: option.value,
    label: option.label,
  })),
];

interface LeadsHeaderActionsProps {
  params: LeadsListParams;
  kind?: PersonKind;
}

function IconSearch() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <circle cx="11" cy="11" r="7" />
      <path d="M20 20l-3.5-3.5" strokeLinecap="round" />
    </svg>
  );
}

function IconFilter() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <path d="M4 6h16M7 12h10M10 18h4" strokeLinecap="round" />
    </svg>
  );
}

function IconClose() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <path d="M6 6l12 12M18 6 6 18" strokeLinecap="round" />
    </svg>
  );
}

export function LeadsHeaderActions({ params, kind = "lead" }: LeadsHeaderActionsProps) {
  const router = useRouter();
  const basePath = personBasePath(kind);
  const plural = personPlural(kind);
  const [searchOpen, setSearchOpen] = useState(params.q.length > 0);
  const [filterOpen, setFilterOpen] = useState(false);
  const [search, setSearch] = useState(params.q);
  const toolbarRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    setSearch(params.q);
    if (params.q.length > 0) setSearchOpen(true);
  }, [params.q]);

  useEffect(() => {
    function onDocClick(e: MouseEvent) {
      if (toolbarRef.current && !toolbarRef.current.contains(e.target as Node)) {
        setFilterOpen(false);
        if (!params.q && !search.trim()) setSearchOpen(false);
      }
    }
    document.addEventListener("mousedown", onDocClick);
    return () => document.removeEventListener("mousedown", onDocClick);
  }, [params.q, search]);

  useEffect(() => {
    if (searchOpen) inputRef.current?.focus();
  }, [searchOpen]);

  function navigate(next: Partial<LeadsListParams>) {
    router.push(`${basePath}${buildLeadsListQuery({ ...params, ...next })}`);
    setFilterOpen(false);
  }

  function handleSearchSubmit(e: React.FormEvent) {
    e.preventDefault();
    navigate({ q: search.trim(), page: 1 });
  }

  function openSearch() {
    setFilterOpen(false);
    setSearchOpen(true);
  }

  function closeSearch() {
    setSearchOpen(false);
    setSearch("");
    if (params.q) navigate({ q: "", page: 1 });
  }

  const searchActive = params.q.length > 0;
  const filterActive = params.status !== "all";
  const searchExpanded = searchOpen || searchActive;

  return (
    <div className={styles.headerToolbar} ref={toolbarRef}>
      <form
        className={`${styles.expandableSearch} ${searchExpanded ? styles.expandableSearchOpen : ""}`}
        onSubmit={handleSearchSubmit}
      >
        <button
          type="button"
          className={`${styles.iconBtn} ${searchActive ? styles.iconBtnActive : ""}`}
          aria-label={`Search ${plural}`}
          aria-expanded={searchExpanded}
          onClick={openSearch}
        >
          <IconSearch />
        </button>
        <input
          ref={inputRef}
          type="search"
          className={styles.expandableSearchInput}
          placeholder="Search name, email, or phone"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          aria-label={`Search ${plural}`}
          tabIndex={searchExpanded ? 0 : -1}
        />
        {searchExpanded && (
          <button
            type="button"
            className={styles.expandableSearchClear}
            aria-label="Clear search"
            onClick={closeSearch}
          >
            <IconClose />
          </button>
        )}
      </form>

      <div className={styles.headerToolbarItem}>
        <button
          type="button"
          className={`${styles.iconBtn} ${filterActive ? styles.iconBtnActive : ""}`}
          aria-label={`Filter ${plural}`}
          aria-expanded={filterOpen}
          onClick={() => setFilterOpen((open) => !open)}
        >
          <IconFilter />
        </button>
        {filterOpen && (
          <div className={styles.toolbarDropdown}>
            <div className={styles.dropdownHeader}>
              <p className={styles.dropdownTitle}>Filter</p>
            </div>
            <div className={styles.dropdownBody}>
              <p className={styles.dropdownSectionLabel}>Status</p>
              <DropdownOptionList
                value={params.status}
                onChange={(status) =>
                  navigate({
                    status: status as LeadsListParams["status"],
                    page: 1,
                  })
                }
                options={STATUS_OPTIONS}
              />
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
