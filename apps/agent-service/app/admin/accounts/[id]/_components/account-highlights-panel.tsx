"use client";

import { useEffect, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { ACCOUNT_INDUSTRIES, ACCOUNT_TYPES } from "@/lib/admin/account-options";
import { updateTenantHighlightsAction } from "@/lib/admin/tenant-config-actions";
import { DropdownSelect } from "@/components/shell/dropdown-select";
import { ExtensionSafeInput } from "@/components/shell/extension-safe-input";
import { PhoneInput } from "@/components/shell/phone-input";
import {
  DisplayField,
  EditFormActions,
  IconEdit,
  InlineEditMessages,
  displayValue,
} from "@/components/shell/inline-edit";
import { formatPhoneDisplay } from "@/lib/phone-display";
import { AccountStatusBadge } from "@/lib/admin/account-status";
import type { PlatformAdminOption } from "@/lib/admin/platform-admin-actions";
import type { TenantConfig } from "@/lib/admin/tenant-config";
import styles from "@/components/shell/shell.module.css";

interface AccountHighlightsPanelProps {
  tenant: TenantConfig;
  platformAdmins: PlatformAdminOption[];
}

function resolveOwnerLabel(
  accountOwnerId: string | null,
  accountOwnerLabel: string | null,
): string {
  if (!accountOwnerId) return "Unassigned";
  return displayValue(accountOwnerLabel);
}

function truncateId(id: string): string {
  if (id.length <= 12) return id;
  return `${id.slice(0, 8)}…`;
}

function TenantIdField({ id }: { id: string }) {
  const [copied, setCopied] = useState(false);

  async function handleCopy() {
    try {
      await navigator.clipboard.writeText(id);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      setCopied(false);
    }
  }

  return (
    <div className={styles.displayField}>
      <span className={styles.displayLabel}>Tenant ID</span>
      <div className={styles.highlightTenantIdRow}>
        <span className={styles.highlightTenantId} title={id}>
          {truncateId(id)}
        </span>
        <button
          type="button"
          className={styles.highlightCopyBtn}
          onClick={handleCopy}
          aria-label={copied ? "Tenant ID copied" : "Copy tenant ID"}
          title={copied ? "Copied" : "Copy full ID"}
        >
          {copied ? (
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden="true">
              <path
                d="M20 6L9 17l-5-5"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          ) : (
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden="true">
              <rect
                x="9"
                y="9"
                width="13"
                height="13"
                rx="2"
                stroke="currentColor"
                strokeWidth="2"
              />
              <path
                d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
              />
            </svg>
          )}
        </button>
      </div>
    </div>
  );
}

export function AccountHighlightsPanel({
  tenant,
  platformAdmins,
}: AccountHighlightsPanelProps) {
  const router = useRouter();
  const [editing, setEditing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);
  const [pending, startTransition] = useTransition();
  const [accountType, setAccountType] = useState(tenant.accountType ?? "Tenant");
  const [phone, setPhone] = useState(tenant.primaryPhone ?? "");
  const [website, setWebsite] = useState(tenant.website ?? "");
  const [accountOwnerId, setAccountOwnerId] = useState(tenant.accountOwnerId ?? "");
  const [industry, setIndustry] = useState(tenant.industry ?? "");

  function resetForm() {
    setAccountType(tenant.accountType ?? "Tenant");
    setPhone(tenant.primaryPhone ?? "");
    setWebsite(tenant.website ?? "");
    setAccountOwnerId(tenant.accountOwnerId ?? "");
    setIndustry(tenant.industry ?? "");
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
      const result = await updateTenantHighlightsAction(formData);
      if (!result.ok) {
        setError(result.error ?? "Could not save highlights.");
        return;
      }
      setSuccess(true);
      setEditing(false);
      router.refresh();
    });
  }

  return (
    <div className={styles.highlightsPanel}>
      <div className={styles.sidebarCardHeader}>
        <div className={styles.sidebarCardHeaderMain}>
          <span className={`${styles.accordionIconBadge} ${styles.highlightsIconBadge}`}>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden="true">
              <path
                d="M6 22V4a2 2 0 012-2h8a2 2 0 012 2v18M6 12H4a2 2 0 00-2 2v6a2 2 0 002 2h2M18 9h2a2 2 0 012 2v9a2 2 0 01-2 2h-2M10 6h4M10 10h4M10 14h4M10 18h4"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </span>
          <h2 className={`${styles.sidebarCardTitle} ${styles.highlightsPanelTitle}`}>Highlights</h2>
        </div>
        {!editing && (
          <IconEdit onClick={() => setEditing(true)} label="Edit highlights" />
        )}
      </div>

      <div className={styles.highlightsPanelBody}>
        {!editing ? (
        <div className={styles.highlightsGrid}>
          <DisplayField label="Account Type" value={tenant.accountType ?? "Tenant"} />
          <DisplayField label="Phone" value={formatPhoneDisplay(tenant.primaryPhone)} />
          <DisplayField label="Website" value={tenant.website} />
          <TenantIdField id={tenant.id} />
          <DisplayField
            label="Owner"
            value={resolveOwnerLabel(tenant.accountOwnerId, tenant.accountOwnerLabel)}
          />
          <DisplayField label="Industry" value={tenant.industry} />
          <div className={styles.displayField}>
            <span className={styles.displayLabel}>Status</span>
            <div className={`${styles.displayValue} ${styles.highlightStatusValue}`}>
              <AccountStatusBadge status={tenant.status} />
            </div>
          </div>
        </div>
      ) : (
        <form onSubmit={handleSubmit}>
          <InlineEditMessages error={error} success={success} />

          <div className={styles.highlightsGrid}>
            <div className={styles.field}>
              <label className={styles.label} htmlFor="highlight-account-type">
                Account Type
              </label>
              <DropdownSelect
                id="highlight-account-type"
                name="accountType"
                value={accountType}
                ariaLabel="Account type"
                disabled={pending}
                onChange={setAccountType}
                options={ACCOUNT_TYPES.map((type) => ({ value: type, label: type }))}
              />
            </div>
            <div className={styles.field}>
              <label className={styles.label} htmlFor="highlight-phone">
                Phone
              </label>
              <PhoneInput
                id="highlight-phone"
                name="phoneE164"
                className={styles.input}
                value={phone}
                disabled={pending}
              />
            </div>
            <div className={styles.field}>
              <label className={styles.label} htmlFor="highlight-website">
                Website
              </label>
              <ExtensionSafeInput
                id="highlight-website"
                name="website"
                type="url"
                className={styles.input}
                value={website}
                onChange={(e) => setWebsite(e.target.value)}
                placeholder="https://example.com"
                disabled={pending}
              />
            </div>
            <TenantIdField id={tenant.id} />
            <div className={styles.field}>
              <label className={styles.label} htmlFor="highlight-account-owner">
                Owner
              </label>
              <DropdownSelect
                id="highlight-account-owner"
                name="accountOwnerId"
                value={accountOwnerId}
                placeholder="Unassigned"
                ariaLabel="Account owner"
                disabled={pending}
                onChange={setAccountOwnerId}
                options={[
                  { value: "", label: "Unassigned" },
                  ...platformAdmins.map((admin) => ({
                    value: admin.userId,
                    label: admin.label,
                  })),
                ]}
              />
            </div>
            <div className={styles.field}>
              <label className={styles.label} htmlFor="highlight-industry">
                Industry
              </label>
              <DropdownSelect
                id="highlight-industry"
                name="industry"
                value={industry}
                placeholder="Select industry"
                ariaLabel="Industry"
                disabled={pending}
                onChange={setIndustry}
                options={[
                  { value: "", label: "Select industry" },
                  ...ACCOUNT_INDUSTRIES.map((value) => ({ value, label: value })),
                ]}
              />
            </div>
            <div className={styles.displayField}>
              <span className={styles.displayLabel}>Status</span>
              <div className={`${styles.displayValue} ${styles.highlightStatusValue}`}>
                <AccountStatusBadge status={tenant.status} />
              </div>
            </div>
          </div>

          <EditFormActions pending={pending} onCancel={handleCancel} saveLabel="Save Highlights" />
        </form>
      )}
      </div>
    </div>
  );
}
