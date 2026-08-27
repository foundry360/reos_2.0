"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import {
  buildUsersListQuery,
  type UsersListParams,
} from "@/lib/admin/users-list-params";
import { DropdownOptionList } from "@/components/shell/dropdown-select";
import styles from "@/components/shell/shell.module.css";

const ROLE_OPTIONS = [
  { value: "all", label: "All user types" },
  { value: "owner", label: "Owner" },
  { value: "agent", label: "Agent" },
  { value: "viewer", label: "Viewer" },
];

interface UsersHeaderActionsProps {
  params: UsersListParams;
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

export function UsersHeaderActions({ params }: UsersHeaderActionsProps) {
  const router = useRouter();
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

  function navigate(next: Partial<UsersListParams>) {
    router.push(`/admin/users${buildUsersListQuery({ ...params, ...next })}`);
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
  const filterActive = params.role !== "all";
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
          aria-label="Search users"
          aria-expanded={searchExpanded}
          onClick={openSearch}
        >
          <IconSearch />
        </button>
        <input
          ref={inputRef}
          type="search"
          className={styles.expandableSearchInput}
          placeholder="Search name or account"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          aria-label="Search users"
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
          aria-label="Filter users"
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
              <p className={styles.dropdownSectionLabel}>User Type</p>
              <DropdownOptionList
                value={params.role}
                onChange={(role) =>
                  navigate({
                    role: role as UsersListParams["role"],
                    page: 1,
                  })
                }
                options={ROLE_OPTIONS}
              />
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
