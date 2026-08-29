"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { createTenantFormAction } from "@/lib/admin/actions";
import { TENANT_TIMEZONES } from "@/lib/admin/timezones";
import { DropdownSelect } from "@/components/shell/dropdown-select";
import { IconPlus } from "@/components/shell/sidebar-nav";
import styles from "@/components/shell/shell.module.css";

const TIMEZONES = TENANT_TIMEZONES;

interface NewAccountModalProps {
  trigger?: "pill" | "link" | "cta";
  linkLabel?: string;
}

export function NewAccountModal({
  trigger = "pill",
  linkLabel = "Create the first one",
}: NewAccountModalProps) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const [timezone, setTimezone] = useState("America/New_York");
  const panelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;

    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }

    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [open]);

  useEffect(() => {
    if (open) {
      setError(null);
      document.body.style.overflow = "hidden";
    } else {
      document.body.style.overflow = "";
    }

    return () => {
      document.body.style.overflow = "";
    };
  }, [open]);

  function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);

    const formData = new FormData(e.currentTarget);

    startTransition(async () => {
      const result = await createTenantFormAction(formData);
      if (!result.ok || !result.tenantId) {
        setError(result.error ?? "Could not create account.");
        return;
      }

      setOpen(false);
      router.push(`/admin/accounts/${result.tenantId}?created=1`);
      router.refresh();
    });
  }

  return (
    <>
      {trigger === "pill" || trigger === "cta" ? (
        <button
          type="button"
          className={`${styles.btnPrimary} ${styles.btnPill}`}
          onClick={() => setOpen(true)}
        >
          {trigger === "pill" ? (
            <>
              <IconPlus />
              New Account
            </>
          ) : (
            linkLabel === "Create the first one" ? "Add an Account" : linkLabel
          )}
        </button>
      ) : (
        <button type="button" className={styles.modalLinkTrigger} onClick={() => setOpen(true)}>
          {linkLabel}
        </button>
      )}

      {open && (
        <div className={styles.modalOverlay} onClick={() => setOpen(false)}>
          <div
            ref={panelRef}
            className={styles.modalPanel}
            role="dialog"
            aria-modal="true"
            aria-labelledby="new-account-title"
            onClick={(e) => e.stopPropagation()}
          >
            <div className={styles.modalHeader}>
              <div>
                <h2 id="new-account-title" className={styles.modalTitle}>
                  New Account
                </h2>
                <p className={styles.modalSubtitle}>Creates a new tenant account.</p>
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

              <div className={styles.field}>
                <label className={styles.label} htmlFor="new-account-name">
                  Realtor Name
                </label>
                <input
                  id="new-account-name"
                  name="name"
                  className={styles.input}
                  placeholder="Harbor Realty"
                  required
                  disabled={pending}
                />
              </div>

              <div className={styles.field}>
                <label className={styles.label} htmlFor="new-account-slug">
                  Account Name
                </label>
                <input
                  id="new-account-slug"
                  name="slug"
                  className={styles.input}
                  placeholder="harbor-realty"
                  disabled={pending}
                />
                <p className={styles.hint}>Leave blank to auto-generate from the name.</p>
              </div>

              <div className={styles.fieldRow}>
                <div className={styles.field}>
                  <label className={styles.label} htmlFor="new-account-principal-first-name">
                    First Name
                  </label>
                  <input
                    id="new-account-principal-first-name"
                    name="principalFirstName"
                    className={styles.input}
                    placeholder="Jane"
                    required
                    disabled={pending}
                  />
                </div>
                <div className={styles.field}>
                  <label className={styles.label} htmlFor="new-account-principal-last-name">
                    Last Name
                  </label>
                  <input
                    id="new-account-principal-last-name"
                    name="principalLastName"
                    className={styles.input}
                    placeholder="Smith"
                    required
                    disabled={pending}
                  />
                </div>
              </div>

              <div className={styles.field}>
                <label className={styles.label} htmlFor="new-account-timezone">
                  Timezone
                </label>
                <DropdownSelect
                  id="new-account-timezone"
                  name="timezone"
                  value={timezone}
                  ariaLabel="Timezone"
                  disabled={pending}
                  onChange={setTimezone}
                  options={TIMEZONES.map((tz) => ({
                    value: tz,
                    label: tz.replace("_", " "),
                  }))}
                />
              </div>

              <div className={styles.modalFooter}>
                <button
                  type="button"
                  className={styles.btnSecondary}
                  onClick={() => setOpen(false)}
                  disabled={pending}
                >
                  Cancel
                </button>
                <button type="submit" className={styles.btnPrimary} disabled={pending}>
                  {pending ? "Creating…" : "Create Account"}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </>
  );
}
