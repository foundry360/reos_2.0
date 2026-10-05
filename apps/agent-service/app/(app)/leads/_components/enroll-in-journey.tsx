"use client";

import Link from "next/link";
import { useEffect, useRef, useState, useTransition, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { useRouter } from "next/navigation";
import { enrollContactInJourneyAction } from "@/lib/journeys/journey-actions";
import {
  enrollmentNotice,
  type EnrollmentNotice,
  type ManualEnrollmentJourneyOption,
} from "@/lib/journeys/manual-enrollment-options";
import styles from "@/components/shell/shell.module.css";
import journeyStyles from "../../marketing/journeys/_components/journeys.module.css";

const MENU_WIDTH = 180;
const MENU_GAP = 6;

const NOTICE_CLASS: Record<EnrollmentNotice["tone"], string> = {
  success: styles.success,
  info: styles.notice,
  error: styles.error,
};

export interface JourneyEnrollmentChoices {
  journeys: ManualEnrollmentJourneyOption[];
  loadFailed: boolean;
}

interface PersonMoreActionsProps {
  contactId: string;
  enrollment: JourneyEnrollmentChoices;
  icon: ReactNode;
  label: string;
  onEnrolled: (message: string) => void;
}

/** The lead page's "More" quick action. */
export function PersonMoreActions({ contactId, enrollment, icon, label, onEnrolled }: PersonMoreActionsProps) {
  const [menuPosition, setMenuPosition] = useState<{ top: number; left: number } | null>(null);
  const [enrollOpen, setEnrollOpen] = useState(false);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const menuOpen = menuPosition !== null;

  function toggleMenu() {
    if (menuOpen) {
      setMenuPosition(null);
      return;
    }
    const rect = buttonRef.current?.getBoundingClientRect();
    if (!rect) return;
    setMenuPosition({
      top: rect.bottom + MENU_GAP,
      left: Math.max(8, Math.min(rect.left, window.innerWidth - MENU_WIDTH - 8)),
    });
  }

  useEffect(() => {
    if (!menuOpen) return;
    const close = () => setMenuPosition(null);
    function onMouseDown(event: MouseEvent) {
      const target = event.target as Node;
      if (menuRef.current?.contains(target) || buttonRef.current?.contains(target)) return;
      close();
    }
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") close();
    }
    document.addEventListener("mousedown", onMouseDown);
    document.addEventListener("keydown", onKeyDown);
    window.addEventListener("scroll", close, true);
    window.addEventListener("resize", close);
    return () => {
      document.removeEventListener("mousedown", onMouseDown);
      document.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("scroll", close, true);
      window.removeEventListener("resize", close);
    };
  }, [menuOpen]);

  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        className={styles.personQuickAction}
        aria-haspopup="menu"
        aria-expanded={menuOpen}
        onClick={toggleMenu}
      >
        <span className={styles.personQuickActionIcon}>{icon}</span>
        <span>{label}</span>
      </button>

      {menuPosition &&
        createPortal(
          <div
            ref={menuRef}
            className={styles.rowActionsDropdownPortal}
            style={{ top: menuPosition.top, left: menuPosition.left, minWidth: MENU_WIDTH }}
            role="menu"
          >
            <button
              type="button"
              className={styles.dropdownItem}
              role="menuitem"
              onClick={() => {
                setMenuPosition(null);
                // Open after the menu unmounts so this click can't land on the overlay.
                window.setTimeout(() => setEnrollOpen(true), 0);
              }}
            >
              Enroll in Journey
            </button>
          </div>,
          document.body,
        )}

      {enrollOpen ? (
        <EnrollInJourneyModal
          contactId={contactId}
          enrollment={enrollment}
          onClose={() => setEnrollOpen(false)}
          onEnrolled={(message) => {
            setEnrollOpen(false);
            onEnrolled(message);
          }}
        />
      ) : null}
    </>
  );
}

interface EnrollInJourneyModalProps {
  contactId: string;
  enrollment: JourneyEnrollmentChoices;
  onClose: () => void;
  onEnrolled: (message: string) => void;
}

export function EnrollInJourneyModal({ contactId, enrollment, onClose, onEnrolled }: EnrollInJourneyModalProps) {
  const router = useRouter();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [notice, setNotice] = useState<EnrollmentNotice | null>(null);
  const [pending, startTransition] = useTransition();
  // Blocks a second click that lands before React re-renders with `pending`.
  const submittingRef = useRef(false);
  const { journeys, loadFailed } = enrollment;

  useEffect(() => {
    document.body.style.overflow = "hidden";
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape" && !submittingRef.current) onClose();
    }
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.body.style.overflow = "";
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [onClose]);

  function close() {
    if (!submittingRef.current) onClose();
  }

  function handleEnroll() {
    if (!selectedId || submittingRef.current) return;
    submittingRef.current = true;
    setNotice(null);
    const journeyId = selectedId;
    startTransition(async () => {
      let next: EnrollmentNotice;
      let enrolled = false;
      try {
        const result = await enrollContactInJourneyAction({ journeyId, contactId });
        next = enrollmentNotice(result.result);
        enrolled = result.result === "enrolled";
      } catch {
        next = enrollmentNotice("failed");
      }
      submittingRef.current = false;
      if (enrolled) {
        onEnrolled(next.message);
        router.refresh();
        return;
      }
      setNotice(next);
    });
  }

  const selectable = journeys.filter((journey) => !journey.alreadyActive);
  const canSubmit = !pending && selectedId !== null && selectable.some((journey) => journey.id === selectedId);

  return createPortal(
    <div className={styles.modalOverlay} onClick={close}>
      <div
        className={`${styles.modalPanel} ${styles.modalPanelWide}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby="enroll-journey-title"
        onClick={(event) => event.stopPropagation()}
      >
        <div className={styles.modalHeader}>
          <div className={styles.modalHeaderText}>
            <h2 id="enroll-journey-title" className={styles.modalTitle}>
              Enroll in Journey
            </h2>
            <p className={styles.modalSubtitle}>Select an active Journey to enroll this lead in.</p>
          </div>
          <button type="button" className={styles.iconBtn} aria-label="Close" onClick={close} disabled={pending}>
            ×
          </button>
        </div>

        <div className={`${styles.modalBody} ${styles.modalBodyScroll}`}>
          {notice ? (
            <p className={NOTICE_CLASS[notice.tone]} role={notice.tone === "error" ? "alert" : "status"}>
              {notice.message}
            </p>
          ) : null}

          {loadFailed ? (
            <p className={styles.error}>Could not load Journeys. Refresh the page and try again.</p>
          ) : journeys.length === 0 ? (
            <div className={journeyStyles.enrollJourneyEmpty}>
              <p className={styles.modalSubtitle}>No Journeys are currently available for manual enrollment.</p>
              <p className={styles.hint}>
                Activate a Journey that starts with a Manual enrollment trigger to enroll leads from here.
              </p>
              <Link href="/marketing/journeys" className={`${styles.btnSecondary} ${styles.btnPill}`}>
                Open Journey Builder
              </Link>
            </div>
          ) : (
            <div className={journeyStyles.enrollJourneyList} role="radiogroup" aria-label="Journeys">
              {journeys.map((journey) => {
                const active = selectedId === journey.id;
                return (
                  <button
                    key={journey.id}
                    type="button"
                    role="radio"
                    aria-checked={active}
                    className={`${journeyStyles.templateOption} ${active ? journeyStyles.templateOptionActive : ""}`}
                    onClick={() => {
                      setSelectedId(journey.id);
                      setNotice(null);
                    }}
                    disabled={pending || journey.alreadyActive}
                  >
                    <span className={journeyStyles.enrollJourneyOptionHeader}>
                      <span className={journeyStyles.templateOptionTitle}>{journey.name}</span>
                      {journey.alreadyActive ? (
                        <span className={`${styles.badge} ${styles.badgeActive}`}>Already active</span>
                      ) : null}
                    </span>
                    {journey.description ? (
                      <span className={journeyStyles.templateOptionDesc}>{journey.description}</span>
                    ) : null}
                  </button>
                );
              })}
            </div>
          )}
        </div>

        <div className={styles.modalFooter}>
          <button
            type="button"
            className={`${styles.btnSecondary} ${styles.btnPill}`}
            onClick={close}
            disabled={pending}
          >
            Cancel
          </button>
          {!loadFailed && journeys.length > 0 ? (
            <button
              type="button"
              className={`${styles.btnPrimary} ${styles.btnPill}`}
              onClick={handleEnroll}
              disabled={!canSubmit}
              aria-busy={pending}
            >
              {pending ? "Enrolling…" : "Enroll"}
            </button>
          ) : null}
        </div>
      </div>
    </div>,
    document.body,
  );
}
