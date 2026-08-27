"use client";

import { useEffect, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import {
  formatTenantStatusLabel,
  normalizeTenantStatus,
  TENANT_STATUS_OPTIONS,
  type TenantStatus,
} from "@/lib/admin/account-status";
import {
  updateTenantAccountInfoAction,
  updateTenantAddressAction,
} from "@/lib/admin/tenant-config-actions";
import { DropdownSelect } from "@/components/shell/dropdown-select";
import {
  DisplayField,
  DisplayGrid,
  EditFormActions,
  InlineEditMessages,
  InlineEditSectionHeader,
} from "@/components/shell/inline-edit";
import { formatAuditDisplay } from "@/lib/admin/audit-display";
import { TENANT_TIMEZONES } from "@/lib/admin/timezones";
import type { TenantConfig } from "@/lib/admin/tenant-config";
import styles from "@/components/shell/shell.module.css";

interface AccountDetailsTabProps {
  tenant: TenantConfig;
}

function AuditFields({ tenant }: { tenant: TenantConfig }) {
  return (
    <>
      <DisplayField
        label="Created By"
        value={formatAuditDisplay(tenant.createdByLabel, tenant.createdAt, tenant.timezone)}
      />
      <DisplayField
        label="Last Modified By"
        value={formatAuditDisplay(tenant.lastModifiedByLabel, tenant.updatedAt, tenant.timezone)}
      />
    </>
  );
}

export function AccountDetailsTab({ tenant }: AccountDetailsTabProps) {
  const router = useRouter();
  const [editingAccount, setEditingAccount] = useState(false);
  const [editingAddress, setEditingAddress] = useState(false);
  const [accountError, setAccountError] = useState<string | null>(null);
  const [addressError, setAddressError] = useState<string | null>(null);
  const [accountSuccess, setAccountSuccess] = useState(false);
  const [addressSuccess, setAddressSuccess] = useState(false);
  const [accountPending, startAccountTransition] = useTransition();
  const [addressPending, startAddressTransition] = useTransition();
  const [name, setName] = useState(tenant.name);
  const [slug, setSlug] = useState(tenant.slug);
  const [street, setStreet] = useState(tenant.street ?? "");
  const [city, setCity] = useState(tenant.city ?? "");
  const [state, setState] = useState(tenant.state ?? "");
  const [postalCode, setPostalCode] = useState(tenant.postalCode ?? "");
  const [country, setCountry] = useState(tenant.country ?? "United States");
  const [timezone, setTimezone] = useState(tenant.timezone);
  const [status, setStatus] = useState<TenantStatus>(() => normalizeTenantStatus(tenant.status));

  function resetAccountForm() {
    setName(tenant.name);
    setSlug(tenant.slug);
    setTimezone(tenant.timezone);
    setStatus(normalizeTenantStatus(tenant.status));
    setAccountError(null);
    setAccountSuccess(false);
  }

  function resetAddressForm() {
    setStreet(tenant.street ?? "");
    setCity(tenant.city ?? "");
    setState(tenant.state ?? "");
    setPostalCode(tenant.postalCode ?? "");
    setCountry(tenant.country ?? "United States");
    setAddressError(null);
    setAddressSuccess(false);
  }

  useEffect(() => {
    if (!editingAccount) resetAccountForm();
  }, [tenant, editingAccount]);

  useEffect(() => {
    if (!editingAddress) resetAddressForm();
  }, [tenant, editingAddress]);

  function handleAccountSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setAccountError(null);
    setAccountSuccess(false);

    const formData = new FormData(e.currentTarget);
    formData.set("tenantId", tenant.id);

    startAccountTransition(async () => {
      const result = await updateTenantAccountInfoAction(formData);
      if (!result.ok) {
        setAccountError(result.error ?? "Could not save account information.");
        return;
      }
      setAccountSuccess(true);
      setEditingAccount(false);
      router.refresh();
    });
  }

  function handleAddressSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setAddressError(null);
    setAddressSuccess(false);

    const formData = new FormData(e.currentTarget);
    formData.set("tenantId", tenant.id);

    startAddressTransition(async () => {
      const result = await updateTenantAddressAction(formData);
      if (!result.ok) {
        setAddressError(result.error ?? "Could not save address.");
        return;
      }
      setAddressSuccess(true);
      setEditingAddress(false);
      router.refresh();
    });
  }

  return (
    <div className={styles.detailsForm}>
      <section className={styles.detailsSection}>
        <InlineEditSectionHeader
          title="Account Information"
          editing={editingAccount}
          onEdit={() => setEditingAccount(true)}
          editLabel="Edit account information"
        />

        {!editingAccount ? (
          <div className={styles.tabPanelBody}>
            <DisplayGrid>
              <DisplayField label="Realtor Name" value={tenant.name} />
              <DisplayField label="Account Name" value={tenant.slug} />
              <DisplayField label="Timezone" value={tenant.timezone.replace("_", " ")} />
              <DisplayField label="Status" value={formatTenantStatusLabel(tenant.status)} />
            </DisplayGrid>
            <div className={styles.detailsAuditGrid}>
              <AuditFields tenant={tenant} />
            </div>
          </div>
        ) : (
          <form className={styles.tabPanelBody} onSubmit={handleAccountSubmit}>
            <InlineEditMessages error={accountError} success={accountSuccess} />
            <div className={styles.detailsFieldGrid}>
              <div className={styles.field}>
                <label className={styles.label} htmlFor="details-name">
                  Realtor Name
                </label>
                <input
                  id="details-name"
                  name="name"
                  className={styles.input}
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  required
                  disabled={accountPending}
                />
              </div>
              <div className={styles.field}>
                <label className={styles.label} htmlFor="details-slug">
                  Account Name
                </label>
                <input
                  id="details-slug"
                  name="slug"
                  className={styles.input}
                  value={slug}
                  onChange={(e) => setSlug(e.target.value)}
                  required
                  disabled={accountPending}
                />
              </div>
              <div className={styles.field}>
                <label className={styles.label} htmlFor="details-timezone">
                  Timezone
                </label>
                <DropdownSelect
                  id="details-timezone"
                  name="timezone"
                  value={timezone}
                  ariaLabel="Timezone"
                  disabled={accountPending}
                  onChange={setTimezone}
                  options={TENANT_TIMEZONES.map((tz) => ({
                    value: tz,
                    label: tz.replace("_", " "),
                  }))}
                />
              </div>
              <div className={styles.field}>
                <label className={styles.label} htmlFor="details-status">
                  Status
                </label>
                <DropdownSelect
                  id="details-status"
                  name="status"
                  value={status}
                  ariaLabel="Account status"
                  disabled={accountPending}
                  onChange={(value) => setStatus(normalizeTenantStatus(value))}
                  options={TENANT_STATUS_OPTIONS.map((option) => ({
                    value: option.value,
                    label: option.label,
                  }))}
                />
              </div>
            </div>
            <div className={styles.detailsAuditGrid}>
              <AuditFields tenant={tenant} />
            </div>
            <EditFormActions
              pending={accountPending}
              onCancel={() => {
                resetAccountForm();
                setEditingAccount(false);
              }}
              saveLabel="Save"
            />
          </form>
        )}
      </section>

      <section className={styles.detailsSection}>
        <InlineEditSectionHeader
          title="Address"
          editing={editingAddress}
          onEdit={() => setEditingAddress(true)}
          editLabel="Edit address"
        />

        {!editingAddress ? (
          <div className={styles.tabPanelBody}>
            <DisplayGrid>
              <DisplayField label="Street" value={tenant.street} />
              <DisplayField label="City" value={tenant.city} />
              <DisplayField label="State" value={tenant.state} />
              <DisplayField label="Postal Code" value={tenant.postalCode} />
            </DisplayGrid>
          </div>
        ) : (
          <form className={styles.tabPanelBody} onSubmit={handleAddressSubmit}>
            <InlineEditMessages error={addressError} success={addressSuccess} />
            <div className={styles.detailsFieldGrid}>
              <div className={`${styles.field} ${styles.detailsFieldWide}`}>
                <label className={styles.label} htmlFor="details-street">
                  Street
                </label>
                <input
                  id="details-street"
                  name="street"
                  className={styles.input}
                  value={street}
                  onChange={(e) => setStreet(e.target.value)}
                  disabled={addressPending}
                />
              </div>
              <div className={styles.field}>
                <label className={styles.label} htmlFor="details-city">
                  City
                </label>
                <input
                  id="details-city"
                  name="city"
                  className={styles.input}
                  value={city}
                  onChange={(e) => setCity(e.target.value)}
                  disabled={addressPending}
                />
              </div>
              <div className={styles.field}>
                <label className={styles.label} htmlFor="details-state">
                  State
                </label>
                <input
                  id="details-state"
                  name="state"
                  className={styles.input}
                  value={state}
                  onChange={(e) => setState(e.target.value)}
                  disabled={addressPending}
                />
              </div>
              <div className={styles.field}>
                <label className={styles.label} htmlFor="details-postal-code">
                  Postal Code
                </label>
                <input
                  id="details-postal-code"
                  name="postalCode"
                  className={styles.input}
                  value={postalCode}
                  onChange={(e) => setPostalCode(e.target.value)}
                  disabled={addressPending}
                />
              </div>
              <div className={styles.field}>
                <label className={styles.label} htmlFor="details-country">
                  Country
                </label>
                <input
                  id="details-country"
                  name="country"
                  className={styles.input}
                  value={country}
                  onChange={(e) => setCountry(e.target.value)}
                  disabled={addressPending}
                />
              </div>
            </div>
            <EditFormActions
              pending={addressPending}
              onCancel={() => {
                resetAddressForm();
                setEditingAddress(false);
              }}
              saveLabel="Save"
            />
          </form>
        )}
      </section>
    </div>
  );
}
