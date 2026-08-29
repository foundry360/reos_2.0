"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { invitePlatformAdminAction } from "@/lib/admin/platform-admin-actions";
import type { PlatformAdminRow } from "@/lib/admin/platform-admin-actions";
import { PlatformAdminsTable } from "./platform-admins-table";
import styles from "@/components/shell/shell.module.css";

interface UserManagementProps {
  admins: PlatformAdminRow[];
  currentUserId: string;
}

export function UserManagement({ admins, currentUserId }: UserManagementProps) {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setSuccess(null);

    const formData = new FormData();
    formData.set("email", email);

    startTransition(async () => {
      const result = await invitePlatformAdminAction(formData);
      if (!result.ok) {
        setError(result.error ?? "Could not invite admin.");
        return;
      }
      setEmail("");
      setSuccess("Invite sent. They will have platform admin access once they accept.");
      router.refresh();
    });
  }

  return (
    <div className={styles.settingsStack}>
      <section className={styles.settingsSection}>
        <h2 className={styles.settingsSectionTitle}>User management</h2>
        <p className={styles.settingsSectionDesc}>
          Platform admins can manage accounts and access the admin portal. New
          users receive an invite email to set their password.
        </p>

        {error && <p className={styles.error}>{error}</p>}
        {success && <p className={styles.success}>{success}</p>}

        <form className={styles.settingsFormWide} onSubmit={handleSubmit}>
          <div className={styles.field}>
            <label className={styles.label} htmlFor="adminEmail">
              Add Platform Admin
            </label>
            <div className={styles.inlineFieldRow}>
              <input
                id="adminEmail"
                type="email"
                className={styles.input}
                placeholder="admin@foundry360.com"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                required
                disabled={pending}
              />
              <button type="submit" className={styles.btnPrimary} disabled={pending}>
                {pending ? "Sending…" : "Send Invite"}
              </button>
            </div>
            <p className={styles.hint}>
              If they already have an account, admin access is granted immediately.
            </p>
          </div>
        </form>
      </section>

      <section className={styles.settingsSection}>
        <h2 className={styles.settingsSectionTitle}>Platform admins</h2>
        <PlatformAdminsTable admins={admins} currentUserId={currentUserId} />
      </section>
    </div>
  );
}
