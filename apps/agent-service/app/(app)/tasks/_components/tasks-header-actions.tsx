"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import {
  buildTasksListQuery,
  TASK_VIEWS,
  type TaskViewId,
  type TasksListParams,
} from "@/lib/crm/tasks-list-params";
import { DropdownOptionList } from "@/components/shell/dropdown-select";
import styles from "@/components/shell/shell.module.css";

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

interface TasksHeaderActionsProps {
  params: TasksListParams;
}

export function TasksHeaderActions({ params }: TasksHeaderActionsProps) {
  const router = useRouter();
  const [searchOpen, setSearchOpen] = useState(params.q.length > 0);
  const [filterOpen, setFilterOpen] = useState(false);
  const [search, setSearch] = useState(params.q);
  const toolbarRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const viewOptions = TASK_VIEWS.map((view) => ({
    value: view.id,
    label: view.label,
  }));

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

  function navigate(next: Partial<TasksListParams>) {
    router.push(`/tasks${buildTasksListQuery({ ...params, ...next })}`);
    setFilterOpen(false);
  }

  function handleSearchSubmit(e: FormEvent) {
    e.preventDefault();
    navigate({ q: search.trim(), page: 1, cpage: 1 });
  }

  function openSearch() {
    setFilterOpen(false);
    setSearchOpen(true);
  }

  function closeSearch() {
    setSearchOpen(false);
    setSearch("");
    if (params.q) navigate({ q: "", page: 1, cpage: 1 });
  }

  const searchActive = params.q.length > 0;
  const filterActive = params.view !== "all";
  const searchExpanded = searchOpen || searchActive;
  const activeViewHint = TASK_VIEWS.find((view) => view.id === params.view)?.hint;

  return (
    <div className={styles.headerToolbar} ref={toolbarRef}>
      <form
        className={`${styles.expandableSearch} ${searchExpanded ? styles.expandableSearchOpen : ""}`}
        onSubmit={handleSearchSubmit}
      >
        <button
          type="button"
          className={`${styles.iconBtn} ${searchActive ? styles.iconBtnActive : ""}`}
          aria-label="Search tasks"
          aria-expanded={searchExpanded}
          onClick={openSearch}
        >
          <IconSearch />
        </button>
        <input
          ref={inputRef}
          type="search"
          className={styles.expandableSearchInput}
          placeholder="Search task title"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          aria-label="Search tasks"
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
          aria-label="Filter tasks"
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
              <p className={styles.dropdownSectionLabel}>Schedule</p>
              <DropdownOptionList
                value={params.view}
                onChange={(view) =>
                  navigate({
                    view: view as TaskViewId,
                    page: 1,
                    cpage: 1,
                  })
                }
                options={viewOptions}
              />
              {activeViewHint ? <p className={styles.fieldHint}>{activeViewHint}</p> : null}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
