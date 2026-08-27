"use client";

import { useEffect, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { updateTenantUserAction } from "@/lib/admin/tenant-user-actions";
import { DropdownSelect } from "@/components/shell/dropdown-select";
import { PhoneInput } from "@/components/shell/phone-input";
import type { TenantUser, TenantUserRole } from "@/lib/admin/tenant-users";
import styles from "@/components/shell/shell.module.css";

const USER_TYPE_OPTIONS: { value: TenantUserRole; label: string }[] = [
  { value: "owner", label: "Owner" },
  { value: "agent", label: "Agent" },
  { value: "viewer", label: "Viewer" },
];

interface AccountUserModalProps {
  tenantId: string;
  user: TenantUser;
  onClose: () => void;
}

export function AccountUserModal({ tenantId, user, onClose }: AccountUserModalProps) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const [name, setName] = useState(user.name);
  const [userType, setUserType] = useState<TenantUserRole>(user.userType);

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

    const formData = new FormData(e.currentTarget);
    formData.set("tenantId", tenantId);
    formData.set("membershipId", user.membershipId);
    formData.set("userId", user.userId);

    startTransition(async () => {
      const result = await updateTenantUserAction(formData);
      if (!result.ok) {
        setError(result.error ?? "Could not save user.");
        return;
      }
      onClose();
      router.refresh();
    });
  }

  return (
    <div className={styles.modalOverlay} onClick={() => !pending && onClose()}>
      <div
        className={styles.modalPanel}
        role="dialog"
        aria-modal="true"
        aria-labelledby="account-user-title"
        onClick={(e) => e.stopPropagation()}
      >
        <div className={styles.modalHeader}>
          <div>
            <h2 id="account-user-title" className={styles.modalTitle}>
              Edit user
            </h2>
            <p className={styles.modalSubtitle}>Update this user&apos;s account details.</p>
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

          <div className={styles.field}>
            <label className={styles.label} htmlFor="user-name">
              Name
            </label>
            <input
              id="user-name"
              name="name"
              className={styles.input}
              value={name}
              onChange={(e) => setName(e.target.value)}
              required
              disabled={pending}
            />
          </div>

          <div className={styles.field}>
            <label className={styles.label} htmlFor="user-email">
              Email
            </label>
            <input
              id="user-email"
              className={styles.input}
              value={user.email}
              readOnly
              disabled
            />
          </div>

          <div className={styles.field}>
            <label className={styles.label} htmlFor="user-phone">
              Phone
            </label>
            <PhoneInput
              id="user-phone"
              name="phone"
              className={styles.input}
              value={user.phone}
              disabled={pending}
            />
          </div>

          <div className={styles.field}>
            <label className={styles.label} htmlFor="user-type">
              User Type
            </label>
            <DropdownSelect
              id="user-type"
              name="userType"
              value={userType}
              ariaLabel="User type"
              disabled={pending}
              onChange={(value) => setUserType(value as TenantUserRole)}
              options={USER_TYPE_OPTIONS}
            />
          </div>

          <div className={styles.modalFooter}>
            <button
              type="button"
              className={styles.btnSecondary}
              onClick={onClose}
              disabled={pending}
            >
              Cancel
            </button>
            <button type="submit" className={styles.btnPrimary} disabled={pending}>
              {pending ? "Saving…" : "Save user"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
