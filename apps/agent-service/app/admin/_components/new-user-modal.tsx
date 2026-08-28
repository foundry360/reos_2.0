"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { createTenantUserAction } from "@/lib/admin/tenant-user-actions";
import type { TenantOption } from "@/lib/admin/tenant-options";
import { DropdownSelect } from "@/components/shell/dropdown-select";
import { ExtensionSafeInput } from "@/components/shell/extension-safe-input";
import { PhoneInput } from "@/components/shell/phone-input";
import { IconPlus } from "@/components/shell/sidebar-nav";
import type { TenantUserRole } from "@/lib/admin/tenant-users";
import styles from "@/components/shell/shell.module.css";

const USER_TYPE_OPTIONS: { value: TenantUserRole; label: string }[] = [
  { value: "owner", label: "Owner" },
  { value: "agent", label: "Agent" },
  { value: "viewer", label: "Viewer" },
];

interface NewUserModalProps {
  tenants: TenantOption[];
  trigger?: "pill" | "link" | "cta";
  linkLabel?: string;
}

export function NewUserModal({
  tenants,
  trigger = "pill",
  linkLabel = "Add the first one",
}: NewUserModalProps) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [inviteUrl, setInviteUrl] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const [tenantId, setTenantId] = useState(tenants[0]?.id ?? "");
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [userType, setUserType] = useState<TenantUserRole>("agent");
  const panelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;

    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape" && !pending) setOpen(false);
    }

    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [open, pending]);

  useEffect(() => {
    if (open) {
      setError(null);
      setSuccess(null);
      setInviteUrl(null);
      if (!tenantId && tenants[0]) setTenantId(tenants[0].id);
      document.body.style.overflow = "hidden";
    } else {
      document.body.style.overflow = "";
    }

    return () => {
      document.body.style.overflow = "";
    };
  }, [open, tenantId, tenants]);

  function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
    setSuccess(null);
    setInviteUrl(null);

    if (!tenantId) {
      setError("Select an account.");
      return;
    }

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
      window.setTimeout(() => setOpen(false), 1600);
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

  const tenantOptions = tenants.map((tenant) => ({
    value: tenant.id,
    label: tenant.name,
  }));

  return (
    <>
      {trigger === "pill" || trigger === "cta" ? (
        <button
          type="button"
          className={`${styles.btnPrimary} ${styles.btnPill}`}
          onClick={() => setOpen(true)}
          disabled={tenants.length === 0}
        >
          {trigger === "pill" ? (
            <>
              <IconPlus />
              New user
            </>
          ) : (
            linkLabel === "Add the first one" ? "Add a User" : linkLabel
          )}
        </button>
      ) : (
        <button type="button" className={styles.modalLinkTrigger} onClick={() => setOpen(true)}>
          {linkLabel}
        </button>
      )}

      {open && (
        <div className={styles.modalOverlay} onClick={() => !pending && setOpen(false)}>
          <div
            ref={panelRef}
            className={styles.modalPanel}
            role="dialog"
            aria-modal="true"
            aria-labelledby="new-user-title"
            onClick={(e) => e.stopPropagation()}
          >
            <div className={styles.modalHeader}>
              <div>
                <h2 id="new-user-title" className={styles.modalTitle}>
                  New user
                </h2>
                <p className={styles.modalSubtitle}>
                  Adds a user to an account and emails them a link to set their password.
                </p>
              </div>
              <button
                type="button"
                className={styles.iconBtn}
                aria-label="Close"
                onClick={() => setOpen(false)}
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
                    <a
                      className={styles.btnPrimary}
                      href={inviteUrl}
                      target="_blank"
                      rel="noreferrer"
                    >
                      Open link
                    </a>
                  </div>
                </div>
              )}

              {!inviteUrl && (
                <>
              <div className={styles.field}>
                <label className={styles.label} htmlFor="new-user-account">
                  Account
                </label>
                <DropdownSelect
                  id="new-user-account"
                  value={tenantId}
                  ariaLabel="Account"
                  placeholder="Select account"
                  disabled={pending || tenants.length === 0 || Boolean(success)}
                  onChange={setTenantId}
                  options={tenantOptions}
                />
              </div>

              <div className={styles.field}>
                <label className={styles.label} htmlFor="new-user-name">
                  Name
                </label>
                <input
                  id="new-user-name"
                  name="name"
                  className={styles.input}
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="Jane Smith"
                  disabled={pending || Boolean(success)}
                />
              </div>

              <div className={styles.field}>
                <label className={styles.label} htmlFor="new-user-email">
                  Email
                </label>
                <ExtensionSafeInput
                  id="new-user-email"
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
                <label className={styles.label} htmlFor="new-user-phone">
                  Phone
                </label>
                <PhoneInput
                  id="new-user-phone"
                  name="phone"
                  className={styles.input}
                  disabled={pending || Boolean(success)}
                />
              </div>

              <div className={styles.field}>
                <label className={styles.label} htmlFor="new-user-type">
                  User Type
                </label>
                <DropdownSelect
                  id="new-user-type"
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
                  onClick={() => setOpen(false)}
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
      )}
    </>
  );
}
