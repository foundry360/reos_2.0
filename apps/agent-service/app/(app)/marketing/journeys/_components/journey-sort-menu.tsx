"use client";

import { Fragment, useEffect, useRef, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import {
  DEFAULT_JOURNEY_SORT,
  JOURNEY_SORT_GROUPS,
  journeySortLabel,
  type JourneySort,
} from "@/lib/journeys/journey-sort";
import shell from "@/components/shell/shell.module.css";
import styles from "./journeys.module.css";

export function JourneySortMenu({ sort }: { sort: JourneySort }) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function onPointerDown(event: PointerEvent) {
      if (!wrapRef.current?.contains(event.target as Node)) setOpen(false);
    }
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") setOpen(false);
    }
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  function choose(next: JourneySort) {
    setOpen(false);
    const params = new URLSearchParams(searchParams.toString());
    if (next === DEFAULT_JOURNEY_SORT) params.delete("sort");
    else params.set("sort", next);
    const query = params.toString();
    router.replace(query ? `${pathname}?${query}` : pathname, { scroll: false });
  }

  return (
    <div className={styles.sortWrap} ref={wrapRef}>
      <button
        type="button"
        className={`${shell.btnSecondary} ${styles.sortButton}`}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        <svg
          width="16"
          height="16"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden
        >
          <path d="M7 4v16M3 16l4 4 4-4" />
          <path d="M17 20V4M13 8l4-4 4 4" />
        </svg>
        <span className={shell.srOnly}>Sort by: </span>
        {journeySortLabel(sort)}
      </button>

      {open ? (
        <div className={styles.sortMenu} role="menu">
          <p className={styles.sortMenuHeading}>Sort by</p>
          {JOURNEY_SORT_GROUPS.map((group, index) => (
            <Fragment key={index}>
              {index > 0 ? <div className={styles.sortMenuDivider} role="separator" /> : null}
              {group.map((option) => {
                const selected = option.id === sort;
                return (
                  <button
                    key={option.id}
                    type="button"
                    role="menuitemradio"
                    aria-checked={selected}
                    className={`${styles.sortMenuItem} ${selected ? styles.sortMenuItemSelected : ""}`}
                    onClick={() => choose(option.id)}
                  >
                    <span className={styles.sortMenuCheck} aria-hidden>
                      {selected ? (
                        <svg
                          width="14"
                          height="14"
                          viewBox="0 0 24 24"
                          fill="none"
                          stroke="currentColor"
                          strokeWidth="2.5"
                          strokeLinecap="round"
                          strokeLinejoin="round"
                        >
                          <path d="M20 6 9 17l-5-5" />
                        </svg>
                      ) : null}
                    </span>
                    {option.label}
                  </button>
                );
              })}
            </Fragment>
          ))}
        </div>
      ) : null}
    </div>
  );
}
