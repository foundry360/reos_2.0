"use client";

import { useEffect, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { createTenantUserAction } from "@/lib/admin/tenant-user-actions";
import { DropdownSelect } from "@/components/shell/dropdown-select";
import { PhoneInput } from "@/components/shell/phone-input";
import { ExtensionSafeInput } from "@/components/shell/extension-safe-input";
import type { TenantUserRole } from "@/lib/admin/tenant-users";
import styles from "@/components/shell/shell.module.css";

const USER_TYPE_OPTIONS: { value: TenantUserRole; label: string }[] = [
  { value: "owner", label: "Owner" },
  { value: "agent", label: "Agent" },
  { value: "viewer", label: "Viewer" },
];

interface AccountAddUserModalProps {
  tenantId: string;
  onClose: () => void;
}

export function AccountAddUserModal({ tenantId, onClose }: AccountAddUserModalProps) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [inviteUrl, setInviteUrl] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [userType, setUserType] = useState<TenantUserRole>("agent");

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape" && !pending) onClose();
    }

    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [onClose, pending]);

  useEffect(() => {
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = "";
    };
  }, []);

  function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
    setSuccess(null);
    setInviteUrl(null);

    const formData = new FormData(e.currentTarget);
    formData.set("tenantId", tenantId);

    startTransition(async () => {
      const result = await createTenantUserAction(formData);
      if (!result.ok) {
        setError(result.error ?? "Could not add user.");
        return;
      }
      setSuccess(result.message ?? "Invite email sent.");
      if (result.inviteUrl) {
        setInviteUrl(result.inviteUrl);
        router.refresh();
        return;
      }
      router.refresh();
      window.setTimeout(() => onClose(), 1600);
    });
  }

  async function copyInviteUrl() {
    if (!inviteUrl) return;
    try {
      await navigator.clipboard.writeText(inviteUrl);
    } catch {
      // ignore
    }
  }

  return (
    <div className={styles.modalOverlay} onClick={() => !pending && onClose()}>
      <div
        className={styles.modalPanel}
        role="dialog"
        aria-modal="true"
        aria-labelledby="add-account-user-title"
        onClick={(e) => e.stopPropagation()}
      >
        <div className={styles.modalHeader}>
          <div>
            <h2 id="add-account-user-title" className={styles.modalTitle}>
              Add user
            </h2>
            <p className={styles.modalSubtitle}>
              Adds a user to this account and emails them a link to set their password.
            </p>
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

        <form className={styles.modalBody} onSubmit={handleSubmit}>
          {error && <p className={styles.error}>{error}</p>}
          {success && <p className={styles.success}>{success}</p>}
          {inviteUrl && (
            <div className={styles.success} style={{ display: "grid", gap: "0.5rem" }}>
              <code style={{ fontSize: "0.75rem", wordBreak: "break-all" }}>{inviteUrl}</code>
              <div style={{ display: "flex", gap: "0.5rem", flexWrap: "wrap" }}>
                <button type="button" className={styles.btnSecondary} onClick={copyInviteUrl}>
                  Copy link
                </button>
                <a className={styles.btnPrimary} href={inviteUrl} target="_blank" rel="noreferrer">
                  Open link
                </a>
              </div>
            </div>
          )}

          {!inviteUrl && (
            <>
          <div className={styles.field}>
            <label className={styles.label} htmlFor="add-user-name">
              Name
            </label>
            <input
              id="add-user-name"
              name="name"
              className={styles.input}
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Jane Smith"
              disabled={pending || Boolean(success)}
            />
          </div>

          <div className={styles.field}>
            <label className={styles.label} htmlFor="add-user-email">
              Email
            </label>
            <ExtensionSafeInput
              id="add-user-email"
              name="email"
              type="email"
              className={styles.input}
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="user@example.com"
              required
              disabled={pending || Boolean(success)}
            />
          </div>

          <div className={styles.field}>
            <label className={styles.label} htmlFor="add-user-phone">
              Phone
            </label>
            <PhoneInput
              id="add-user-phone"
              name="phone"
              className={styles.input}
              disabled={pending || Boolean(success)}
            />
          </div>

          <div className={styles.field}>
            <label className={styles.label} htmlFor="add-user-type">
              User Type
            </label>
            <DropdownSelect
              id="add-user-type"
              name="userType"
              value={userType}
              ariaLabel="User type"
              disabled={pending || Boolean(success)}
              onChange={(value) => setUserType(value as TenantUserRole)}
              options={USER_TYPE_OPTIONS}
            />
          </div>
            </>
          )}

          <div className={styles.modalFooter}>
            <button
              type="button"
              className={styles.btnSecondary}
              onClick={onClose}
              disabled={pending}
            >
              {success || inviteUrl ? "Done" : "Cancel"}
            </button>
            {!success && !inviteUrl && (
              <button type="submit" className={styles.btnPrimary} disabled={pending}>
                {pending ? "Sending…" : "Add user"}
              </button>
            )}
          </div>
        </form>
      </div>
    </div>
  );
}
