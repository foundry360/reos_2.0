"use client";

import { useEffect, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { updateTenantComplianceAction } from "@/lib/admin/tenant-config-actions";
import {
  DisplayField,
  DisplayGrid,
  EditFormActions,
  IconEdit,
  InlineEditMessages,
} from "@/components/shell/inline-edit";
import type { TenantAgentConfig } from "@/lib/admin/tenant-config";
import styles from "@/components/shell/shell.module.css";

interface AccountComplianceFormProps {
  tenantId: string;
  agents: TenantAgentConfig;
}

function toTimeInputValue(value: string | null): string {
  if (!value) return "";
  return value.slice(0, 5);
}

function formatTime(value: string | null): string {
  if (!value) return "—";
  return toTimeInputValue(value);
}

export function AccountComplianceForm({ tenantId, agents }: AccountComplianceFormProps) {
  const router = useRouter();
  const [editing, setEditing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);
  const [pending, startTransition] = useTransition();
  const [complianceStrict, setComplianceStrict] = useState(agents.complianceStrict);
  const [quietHoursStart, setQuietHoursStart] = useState(
    toTimeInputValue(agents.quietHoursStart),
  );
  const [quietHoursEnd, setQuietHoursEnd] = useState(toTimeInputValue(agents.quietHoursEnd));

  function resetForm() {
    setComplianceStrict(agents.complianceStrict);
    setQuietHoursStart(toTimeInputValue(agents.quietHoursStart));
    setQuietHoursEnd(toTimeInputValue(agents.quietHoursEnd));
    setError(null);
    setSuccess(false);
  }

  useEffect(() => {
    if (!editing) resetForm();
  }, [agents, editing]);

  function handleCancel() {
    resetForm();
    setEditing(false);
  }

  function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
    setSuccess(false);

    const formData = new FormData(e.currentTarget);
    formData.set("tenantId", tenantId);
    if (complianceStrict) formData.set("complianceStrict", "on");

    startTransition(async () => {
      const result = await updateTenantComplianceAction(formData);
      if (!result.ok) {
        setError(result.error ?? "Could not save compliance settings.");
        return;
      }
      setSuccess(true);
      setEditing(false);
      router.refresh();
    });
  }

  return (
    <>
      <div className={styles.tabPanelHeader}>
        {!editing && <IconEdit onClick={() => setEditing(true)} label="Edit compliance" />}
      </div>

      {!editing ? (
        <div className={styles.tabPanelBody}>
          <DisplayGrid>
          <DisplayField
            label="Strict compliance mode"
            value={agents.complianceStrict ? "On" : "Off"}
          />
          <DisplayField label="Quiet hours start" value={formatTime(agents.quietHoursStart)} />
          <DisplayField label="Quiet hours end" value={formatTime(agents.quietHoursEnd)} />
          </DisplayGrid>
        </div>
      ) : (
        <form className={`${styles.tabPanelBody} ${styles.settingsFormWide}`} onSubmit={handleSubmit}>
          <InlineEditMessages error={error} success={success} />

          <label className={styles.checkboxRow}>
            <input
              type="checkbox"
              name="complianceStrict"
              checked={complianceStrict}
              onChange={(e) => setComplianceStrict(e.target.checked)}
              disabled={pending}
            />
            <span>
              <strong>Strict compliance mode</strong>
              <small>Enforce opt-out keywords and quiet hours before outbound messages.</small>
            </span>
          </label>

          <div className={styles.fieldRow}>
            <div className={styles.field}>
              <label className={styles.label} htmlFor="quiet-hours-start">
                Quiet hours start
              </label>
              <input
                id="quiet-hours-start"
                name="quietHoursStart"
                type="time"
                className={styles.input}
                value={quietHoursStart}
                onChange={(e) => setQuietHoursStart(e.target.value)}
                disabled={pending}
              />
            </div>
            <div className={styles.field}>
              <label className={styles.label} htmlFor="quiet-hours-end">
                Quiet hours end
              </label>
              <input
                id="quiet-hours-end"
                name="quietHoursEnd"
                type="time"
                className={styles.input}
                value={quietHoursEnd}
                onChange={(e) => setQuietHoursEnd(e.target.value)}
                disabled={pending}
              />
            </div>
          </div>

          <EditFormActions pending={pending} onCancel={handleCancel} saveLabel="Save compliance" />
        </form>
      )}
    </>
  );
}
