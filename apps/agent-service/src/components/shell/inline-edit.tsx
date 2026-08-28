"use client";

import type { ReactNode } from "react";
import { displayValue } from "@/lib/display-value";
import styles from "./shell.module.css";

export { displayValue };

export function DisplayField({
  label,
  value,
}: {
  label: string;
  value: string | null | undefined;
}) {
  return (
    <div className={styles.displayField}>
      <span className={styles.displayLabel}>{label}</span>
      <span className={styles.displayValue}>{displayValue(value)}</span>
    </div>
  );
}

export function IconEdit({ onClick, label }: { onClick: () => void; label: string }) {
  return (
    <button type="button" className={styles.inlineEditBtn} onClick={onClick} aria-label={label}>
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden="true">
        <path
          d="M12 20h9M16.5 3.5a2.12 2.12 0 013 3L7 19l-4 1 1-4L16.5 3.5z"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    </button>
  );
}

interface InlineEditHeaderProps {
  title?: string;
  editing: boolean;
  onEdit: () => void;
  editLabel: string;
}

export function InlineEditHeader({ title, editing, onEdit, editLabel }: InlineEditHeaderProps) {
  return (
    <div className={styles.inlineEditHeader}>
      {title ? <h2 className={styles.inlineEditTitle}>{title}</h2> : <span />}
      {!editing && <IconEdit onClick={onEdit} label={editLabel} />}
    </div>
  );
}

interface InlineEditSectionHeaderProps {
  title: string;
  editing: boolean;
  onEdit: () => void;
  editLabel: string;
}

export function InlineEditSectionHeader({
  title,
  editing,
  onEdit,
  editLabel,
}: InlineEditSectionHeaderProps) {
  return (
    <div className={styles.inlineEditSectionHeader}>
      <h3 className={styles.detailsSectionTitle}>{title}</h3>
      {!editing && <IconEdit onClick={onEdit} label={editLabel} />}
    </div>
  );
}

export function EditFormActions({
  pending,
  onCancel,
  saveLabel = "Save",
}: {
  pending: boolean;
  onCancel: () => void;
  saveLabel?: string;
}) {
  return (
    <div className={styles.editFormActions}>
      <button type="button" className={styles.btnSecondary} onClick={onCancel} disabled={pending}>
        Cancel
      </button>
      <button type="submit" className={styles.btnPrimary} disabled={pending}>
        {pending ? "Saving…" : saveLabel}
      </button>
    </div>
  );
}

export function InlineEditMessages({
  error,
  success,
}: {
  error: string | null;
  success: boolean;
}) {
  return (
    <>
      {error && <p className={styles.error}>{error}</p>}
      {success && <p className={styles.success}>Saved.</p>}
    </>
  );
}

export function DisplayGrid({ children }: { children: ReactNode }) {
  return <div className={styles.displayGrid}>{children}</div>;
}

export function DisplayStack({ children }: { children: ReactNode }) {
  return <div className={styles.displayStack}>{children}</div>;
}
