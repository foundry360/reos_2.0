"use client";

import { useEffect, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { updateTenantBillingAction } from "@/lib/admin/tenant-config-actions";
import {
  DisplayField,
  DisplayStack,
  EditFormActions,
  IconEdit,
  InlineEditMessages,
} from "@/components/shell/inline-edit";
import type { TenantConfig } from "@/lib/admin/tenant-config";
import styles from "@/components/shell/shell.module.css";

interface AccountBillingFormProps {
  tenant: TenantConfig;
}

export function AccountBillingForm({ tenant }: AccountBillingFormProps) {
  const router = useRouter();
  const [editing, setEditing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);
  const [pending, startTransition] = useTransition();
  const [stripeCustomerId, setStripeCustomerId] = useState(tenant.stripeCustomerId ?? "");
  const [internalNotes, setInternalNotes] = useState(tenant.internalNotes ?? "");

  function resetForm() {
    setStripeCustomerId(tenant.stripeCustomerId ?? "");
    setInternalNotes(tenant.internalNotes ?? "");
    setError(null);
    setSuccess(false);
  }

  useEffect(() => {
    if (!editing) resetForm();
  }, [tenant, editing]);

  function handleCancel() {
    resetForm();
    setEditing(false);
  }

  function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
    setSuccess(false);

    const formData = new FormData(e.currentTarget);
    formData.set("tenantId", tenant.id);

    startTransition(async () => {
      const result = await updateTenantBillingAction(formData);
      if (!result.ok) {
        setError(result.error ?? "Could not save billing details.");
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
        {!editing && <IconEdit onClick={() => setEditing(true)} label="Edit billing" />}
      </div>

      {!editing ? (
        <div className={styles.tabPanelBody}>
          <DisplayStack>
          <DisplayField label="Stripe customer ID" value={tenant.stripeCustomerId} />
          <DisplayField label="Internal notes" value={tenant.internalNotes} />
          </DisplayStack>
        </div>
      ) : (
        <form className={`${styles.tabPanelBody} ${styles.settingsFormWide}`} onSubmit={handleSubmit}>
          <InlineEditMessages error={error} success={success} />

          <div className={styles.field}>
            <label className={styles.label} htmlFor="stripe-customer-id">
              Stripe customer ID
            </label>
            <input
              id="stripe-customer-id"
              name="stripeCustomerId"
              className={styles.input}
              value={stripeCustomerId}
              onChange={(e) => setStripeCustomerId(e.target.value)}
              placeholder="cus_..."
              disabled={pending}
            />
          </div>

          <div className={styles.field}>
            <label className={styles.label} htmlFor="internal-notes">
              Internal notes
            </label>
            <textarea
              id="internal-notes"
              name="internalNotes"
              className={styles.textarea}
              rows={4}
              value={internalNotes}
              onChange={(e) => setInternalNotes(e.target.value)}
              placeholder="Contractor assignment, onboarding notes, etc."
              disabled={pending}
            />
          </div>

          <EditFormActions pending={pending} onCancel={handleCancel} saveLabel="Save billing" />
        </form>
      )}
    </>
  );
}
