"use client";

import { useEffect, useRef, useState } from "react";
import type { MetaChannel } from "@/lib/meta/oauth";
import type { MetaPageOption } from "@/lib/meta/pages";
import styles from "@/components/shell/shell.module.css";

interface SelectMetaPageModalProps {
  open: boolean;
  channel: MetaChannel;
  pages: MetaPageOption[];
  loading?: boolean;
  pending?: boolean;
  error?: string | null;
  onClose: () => void;
  onConfirm: (pageId: string) => void;
}

export function SelectMetaPageModal({
  open,
  channel,
  pages,
  loading = false,
  pending = false,
  error = null,
  onClose,
  onConfirm,
}: SelectMetaPageModalProps) {
  const [selectedPageId, setSelectedPageId] = useState("");
  const panelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) {
      setSelectedPageId("");
      return;
    }

    if (pages.length === 1) {
      setSelectedPageId(pages[0].id);
    }

    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape" && !pending) onClose();
    }

    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [open, pages, pending, onClose]);

  useEffect(() => {
    if (open) {
      document.body.style.overflow = "hidden";
    } else {
      document.body.style.overflow = "";
    }

    return () => {
      document.body.style.overflow = "";
    };
  }, [open]);

  if (!open) return null;

  const title = channel === "instagram" ? "Select Instagram Page" : "Select Facebook Page";
  const subtitle =
    channel === "instagram"
      ? "Choose the Facebook Page linked to the Instagram account for this tenant."
      : "Choose which Facebook Page Messenger should use for this tenant.";

  return (
    <div className={styles.modalOverlay} onClick={() => !pending && onClose()}>
      <div
        ref={panelRef}
        className={styles.modalPanel}
        role="dialog"
        aria-modal="true"
        aria-labelledby="select-meta-page-title"
        onClick={(e) => e.stopPropagation()}
      >
        <div className={styles.modalHeader}>
          <div>
            <h2 id="select-meta-page-title" className={styles.modalTitle}>
              {title}
            </h2>
            <p className={styles.modalSubtitle}>{subtitle}</p>
          </div>
          <button
            type="button"
            className={styles.iconBtn}
            aria-label="Close"
            onClick={onClose}
            disabled={pending}
          >
            ×
          </button>
        </div>

        <div className={styles.modalBody}>
          {loading ? (
            <p className={styles.modalSubtitle}>Loading Pages…</p>
          ) : pages.length === 0 ? (
            <p className={styles.error}>
              {channel === "instagram"
                ? "No Pages with a linked Instagram professional account were found."
                : "No Facebook Pages were found for this account."}
            </p>
          ) : (
            <div role="radiogroup" aria-label="Facebook Pages">
              {pages.map((page) => {
                const detail =
                  channel === "instagram" && page.instagramUsername
                    ? `@${page.instagramUsername.replace(/^@/, "")}`
                    : channel === "instagram" && page.instagramMessagingEligible
                      ? "Instagram messaging linked"
                      : null;

                return (
                  <label
                    key={page.id}
                    className={styles.connectionRow}
                    style={{ cursor: pending ? "default" : "pointer" }}
                  >
                    <div className={styles.connectionMeta}>
                      <span className={styles.connectionName}>{page.name}</span>
                      {detail ? (
                        <span className={styles.connectionDesc}>{detail}</span>
                      ) : (
                        <span className={styles.connectionDesc}>Page ID {page.id}</span>
                      )}
                    </div>
                    <input
                      type="radio"
                      name="meta-page"
                      value={page.id}
                      checked={selectedPageId === page.id}
                      onChange={() => setSelectedPageId(page.id)}
                      disabled={pending}
                    />
                  </label>
                );
              })}
            </div>
          )}

          {error ? <p className={styles.error}>{error}</p> : null}

          <div className={styles.modalFooter}>
            <button
              type="button"
              className={styles.btnSecondary}
              onClick={onClose}
              disabled={pending}
            >
              Cancel
            </button>
            <button
              type="button"
              className={styles.btnPrimary}
              disabled={pending || loading || !selectedPageId || pages.length === 0}
              onClick={() => onConfirm(selectedPageId)}
            >
              {pending ? "Connecting…" : "Connect Page"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
