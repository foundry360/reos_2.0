"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import styles from "./shell.module.css";

const DROPDOWN_WIDTH = 140;
const DROPDOWN_GAP = 6;

interface RowActionsMenuProps {
  ariaLabel: string;
  disabled?: boolean;
  estimatedHeight?: number;
  stopDrag?: boolean;
  className?: string;
  children: ReactNode;
}

function IconMoreVertical() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <circle cx="12" cy="5" r="1.5" fill="currentColor" />
      <circle cx="12" cy="12" r="1.5" fill="currentColor" />
      <circle cx="12" cy="19" r="1.5" fill="currentColor" />
    </svg>
  );
}

interface MenuPosition {
  top: number;
  left: number;
}

export function RowActionsMenu({
  ariaLabel,
  disabled = false,
  estimatedHeight = 132,
  stopDrag = false,
  className,
  children,
}: RowActionsMenuProps) {
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState<MenuPosition | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);

  function updatePosition() {
    const button = buttonRef.current;
    if (!button) return;

    const rect = button.getBoundingClientRect();
    const spaceBelow = window.innerHeight - rect.bottom;
    const openAbove = spaceBelow < estimatedHeight + DROPDOWN_GAP;

    setPosition({
      top: openAbove
        ? rect.top - estimatedHeight - DROPDOWN_GAP
        : rect.bottom + DROPDOWN_GAP,
      left: Math.max(8, rect.right - DROPDOWN_WIDTH),
    });
  }

  function toggleMenu() {
    setOpen((current) => {
      const nextOpen = !current;
      if (nextOpen) {
        updatePosition();
      } else {
        setPosition(null);
      }
      return nextOpen;
    });
  }

  function closeMenu() {
    setOpen(false);
    setPosition(null);
  }

  function handleMenuClick(event: React.MouseEvent<HTMLDivElement>) {
    if ((event.target as HTMLElement).closest('[role="menuitem"]')) {
      closeMenu();
    }
  }

  useEffect(() => {
    if (!open) return;

    updatePosition();
    window.addEventListener("scroll", updatePosition, true);
    window.addEventListener("resize", updatePosition);
    return () => {
      window.removeEventListener("scroll", updatePosition, true);
      window.removeEventListener("resize", updatePosition);
    };
  }, [open, estimatedHeight]);

  useEffect(() => {
    if (!open) return;

    function onDocClick(event: MouseEvent) {
      const target = event.target as Node;
      if (menuRef.current?.contains(target)) return;
      if (dropdownRef.current?.contains(target)) return;
      setOpen(false);
    }

    document.addEventListener("mousedown", onDocClick);
    return () => document.removeEventListener("mousedown", onDocClick);
  }, [open]);

  return (
    <>
      <div
        className={`${styles.rowActionsMenu} ${className ?? ""}`.trim()}
        ref={menuRef}
        onPointerDown={stopDrag ? (event) => event.stopPropagation() : undefined}
      >
        <button
          ref={buttonRef}
          type="button"
          className={styles.rowActionsBtn}
          aria-label={ariaLabel}
          aria-expanded={open}
          aria-haspopup="menu"
          disabled={disabled}
          onClick={toggleMenu}
        >
          <IconMoreVertical />
        </button>
      </div>

      {open &&
        position &&
        createPortal(
          <div
            ref={dropdownRef}
            className={styles.rowActionsDropdownPortal}
            style={{ top: position.top, left: position.left }}
            role="menu"
            onClick={handleMenuClick}
          >
            {children}
          </div>,
          document.body,
        )}
    </>
  );
}
