"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { updateTenantAgentsAction } from "@/lib/admin/tenant-config-actions";
import {
  EditFormActions,
  IconEdit,
  InlineEditMessages,
} from "@/components/shell/inline-edit";
import type { TenantAgentConfig } from "@/lib/admin/tenant-config";
import styles from "@/components/shell/shell.module.css";

interface AccountAgentsFormProps {
  tenantId: string;
  agents: TenantAgentConfig;
}

const AGENT_OPTIONS = [
  { name: "conciergeEnabled", label: "Concierge", desc: "Qualify leads in SMS conversations." },
  { name: "schedulerEnabled", label: "Scheduler", desc: "Handle booking when leads are ready." },
  { name: "followUpEnabled", label: "Follow-Up", desc: "Nurture and post-appointment check-ins." },
  { name: "intakeEnabled", label: "Intake", desc: "Create contacts from new inbound messages." },
  { name: "researcherEnabled", label: "Researcher", desc: "Background enrichment jobs." },
  { name: "scoutEnabled", label: "Scout", desc: "Proactive re-engagement signals." },
] as const;

export function AccountAgentsForm({ tenantId, agents }: AccountAgentsFormProps) {
  const router = useRouter();
  const [editing, setEditing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);
  const [pending, startTransition] = useTransition();
  const [values, setValues] = useState(agents);

  function resetForm() {
    setValues(agents);
    setError(null);
    setSuccess(false);
  }

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

    startTransition(async () => {
      const result = await updateTenantAgentsAction(formData);
      if (!result.ok) {
        setError(result.error ?? "Could not save agent settings.");
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
        {!editing && <IconEdit onClick={() => setEditing(true)} label="Edit agents" />}
      </div>

      {!editing ? (
        <div className={styles.tabPanelBody}>
          <div className={styles.agentDisplayList}>
          {AGENT_OPTIONS.map((option) => {
            const enabled = agents[option.name];
            return (
              <div key={option.name} className={styles.agentDisplayItem}>
                <span>{option.label}</span>
                <span
                  className={`${styles.agentDisplayStatus} ${enabled ? styles.agentDisplayStatusOn : ""}`}
                >
                  {enabled ? "On" : "Off"}
                </span>
              </div>
            );
          })}
          </div>
        </div>
      ) : (
        <form className={`${styles.tabPanelBody} ${styles.settingsFormWide}`} onSubmit={handleSubmit}>
          <InlineEditMessages error={error} success={success} />

          <div className={styles.checkboxGrid}>
            {AGENT_OPTIONS.map((option) => (
              <label key={option.name} className={styles.checkboxCard}>
                <input
                  type="checkbox"
                  name={option.name}
                  checked={values[option.name]}
                  onChange={(e) =>
                    setValues((current) => ({ ...current, [option.name]: e.target.checked }))
                  }
                  disabled={pending}
                />
                <span>
                  <strong>{option.label}</strong>
                  <small>{option.desc}</small>
                </span>
              </label>
            ))}
          </div>

          <EditFormActions pending={pending} onCancel={handleCancel} saveLabel="Save Agents" />
        </form>
      )}
    </>
  );
}
