"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import {
  disconnectTenantChannelAction,
  updateTenantAgentToggleAction,
} from "@/lib/admin/tenant-config-actions";
import { formatPhoneDisplay } from "@/lib/phone-display";
import type { TenantChannelStatus, TenantConfig } from "@/lib/admin/tenant-config";
import styles from "@/components/shell/shell.module.css";

interface AccountConnectionsSectionsProps {
  tenant: TenantConfig;
}

type ConnectionSection = "connected" | "social";

const SECTIONS: { id: ConnectionSection; label: string }[] = [
  { id: "connected", label: "Connected channels" },
  { id: "social", label: "Social channels" },
];

function ConnectionToggle({
  checked,
  disabled,
  label,
  onChange,
}: {
  checked: boolean;
  disabled?: boolean;
  label: string;
  onChange: (next: boolean) => void;
}) {
  return (
    <label className={styles.connectionToggle}>
      <input
        type="checkbox"
        className={styles.connectionToggleInput}
        checked={checked}
        disabled={disabled}
        aria-label={label}
        onChange={(e) => onChange(e.target.checked)}
      />
      <span className={styles.connectionToggleTrack} aria-hidden="true">
        <span className={styles.connectionToggleThumb} />
      </span>
    </label>
  );
}

function IconLink() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path
        d="M10 13a5 5 0 007.54.54l2.92-2.92a5 5 0 00-7.07-7.07l-1.2 1.21"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M14 11a5 5 0 00-7.54-.54L3.54 13.38a5 5 0 007.07 7.07l1.2-1.21"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function IconTrash() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path
        d="M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function AccordionChevron({ open }: { open: boolean }) {
  return (
    <svg
      className={`${styles.accordionChevron} ${open ? styles.accordionChevronOpen : ""}`}
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      aria-hidden="true"
    >
      <path
        d="M6 9l6 6 6-6"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function AccordionSectionIcon({ sectionId }: { sectionId: ConnectionSection }) {
  if (sectionId === "connected") {
    return (
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden="true">
        <path
          d="M10 13a5 5 0 007.54.54l2.92-2.92a5 5 0 00-7.07-7.07l-1.2 1.21"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
        <path
          d="M14 11a5 5 0 00-7.54-.54L3.54 13.38a5 5 0 007.07 7.07l1.2-1.21"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    );
  }

  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="2" />
      <path
        d="M8 12h8M12 8v8"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
      />
    </svg>
  );
}

const ACCORDION_ICON_CLASSES: Record<ConnectionSection, string> = {
  connected: styles.accordionIconConnections,
  social: styles.accordionIconSocial,
};

function getConnectedChannelCount(tenant: TenantConfig): number {
  let count = 0;
  if (tenant.primaryPhone) count++;
  if (tenant.agents.conciergeEnabled) count++;
  if (tenant.agents.intakeEnabled) count++;
  if (tenant.stripeCustomerId) count++;
  return count;
}

function getConnectedSocialChannelCount(tenant: TenantConfig): number {
  return tenant.channelAccounts.filter(
    (entry) =>
      (entry.channel === "messenger" || entry.channel === "instagram") &&
      entry.status === "connected",
  ).length;
}

function getSectionCount(sectionId: ConnectionSection, tenant: TenantConfig): number {
  if (sectionId === "connected") return getConnectedChannelCount(tenant);
  return getConnectedSocialChannelCount(tenant);
}

function channelMeta(channel: TenantChannelStatus): string {
  if (channel.status === "connected" && channel.accountLabel) {
    return channel.accountLabel.startsWith("@")
      ? channel.accountLabel
      : `@${channel.accountLabel}`;
  }
  if (channel.status === "error") return "Connection error";
  return "Not connected";
}

export function AccountConnectionsSections({ tenant }: AccountConnectionsSectionsProps) {
  const router = useRouter();
  const [openSections, setOpenSections] = useState<Set<ConnectionSection>>(() => new Set());
  const [pending, startTransition] = useTransition();

  const twilioConnected = Boolean(tenant.primaryPhone);
  const stripeConnected = Boolean(tenant.stripeCustomerId);
  const messenger = tenant.channelAccounts.find((entry) => entry.channel === "messenger");
  const instagram = tenant.channelAccounts.find((entry) => entry.channel === "instagram");

  function toggleSection(id: ConnectionSection) {
    setOpenSections((current) => {
      const next = new Set(current);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  }

  function toggleAgent(field: "conciergeEnabled" | "intakeEnabled", enabled: boolean) {
    const formData = new FormData();
    formData.set("tenantId", tenant.id);
    formData.set("field", field);
    formData.set("enabled", String(enabled));

    startTransition(async () => {
      const result = await updateTenantAgentToggleAction(formData);
      if (!result.ok) window.alert(result.error ?? "Could not update connection.");
      else router.refresh();
    });
  }

  function disconnectChannel(channel: "messenger" | "instagram") {
    const formData = new FormData();
    formData.set("tenantId", tenant.id);
    formData.set("channel", channel);

    startTransition(async () => {
      const result = await disconnectTenantChannelAction(formData);
      if (!result.ok) window.alert(result.error ?? "Could not disconnect channel.");
      else router.refresh();
    });
  }

  function connectChannel(channel: "messenger" | "instagram") {
    window.location.href = `/api/oauth/meta/start?tenantId=${encodeURIComponent(tenant.id)}&channel=${channel}`;
  }

  function renderConnectedChannels() {
    return (
      <ul className={styles.connectionsList}>
        <li className={styles.connectionRow}>
          <div className={styles.connectionMeta}>
            <span className={styles.connectionName}>Twilio SMS</span>
            <span className={styles.connectionDesc}>
              {twilioConnected
                ? formatPhoneDisplay(tenant.primaryPhone)
                : "Assign a phone number in Highlights"}
            </span>
          </div>
          <ConnectionToggle
            checked={twilioConnected}
            disabled
            label="Twilio SMS connected"
            onChange={() => undefined}
          />
        </li>

        <li className={styles.connectionRow}>
          <div className={styles.connectionMeta}>
            <span className={styles.connectionName}>AI Concierge</span>
            <span className={styles.connectionDesc}>Inbound SMS agent responses</span>
          </div>
          <ConnectionToggle
            checked={tenant.agents.conciergeEnabled}
            disabled={pending}
            label="AI Concierge enabled"
            onChange={(enabled) => toggleAgent("conciergeEnabled", enabled)}
          />
        </li>

        <li className={styles.connectionRow}>
          <div className={styles.connectionMeta}>
            <span className={styles.connectionName}>Intake</span>
            <span className={styles.connectionDesc}>Create contacts from new leads</span>
          </div>
          <ConnectionToggle
            checked={tenant.agents.intakeEnabled}
            disabled={pending}
            label="Intake enabled"
            onChange={(enabled) => toggleAgent("intakeEnabled", enabled)}
          />
        </li>

        <li className={styles.connectionRow}>
          <div className={styles.connectionMeta}>
            <span className={styles.connectionName}>Stripe</span>
            <span className={styles.connectionDesc}>
              {stripeConnected ? tenant.stripeCustomerId : "Not configured"}
            </span>
          </div>
          <ConnectionToggle
            checked={stripeConnected}
            disabled
            label="Stripe connected"
            onChange={() => undefined}
          />
        </li>
      </ul>
    );
  }

  function renderSocialChannels() {
    return (
      <ul className={styles.connectionsList}>
        {[messenger, instagram].filter(Boolean).map((channel) => {
          const connected = channel!.status === "connected";
          const label = channel!.channel === "messenger" ? "Facebook Messenger" : "Instagram";

          return (
            <li key={channel!.channel} className={styles.connectionRow}>
              <div className={styles.connectionMeta}>
                <span className={styles.connectionName}>{label}</span>
                <span className={styles.connectionDesc}>{channelMeta(channel!)}</span>
              </div>
              {connected ? (
                <button
                  type="button"
                  className={`${styles.connectionActionBtn} ${styles.connectionActionBtnDanger}`}
                  aria-label={`Disconnect ${label}`}
                  disabled={pending}
                  onClick={() =>
                    disconnectChannel(channel!.channel as "messenger" | "instagram")
                  }
                >
                  <IconTrash />
                </button>
              ) : (
                <button
                  type="button"
                  className={styles.connectionActionBtn}
                  aria-label={`Connect ${label}`}
                  disabled={pending}
                  onClick={() =>
                    connectChannel(channel!.channel as "messenger" | "instagram")
                  }
                >
                  <IconLink />
                </button>
              )}
            </li>
          );
        })}
      </ul>
    );
  }

  function renderSectionContent(id: ConnectionSection) {
    if (id === "connected") return renderConnectedChannels();
    return renderSocialChannels();
  }

  return (
    <>
      {SECTIONS.map((section) => {
        const open = openSections.has(section.id);

        return (
          <section key={section.id} className={styles.accordionSection}>
            <button
              type="button"
              className={styles.accordionTrigger}
              aria-expanded={open}
              onClick={() => toggleSection(section.id)}
            >
              <span className={styles.accordionTriggerMain}>
                <span
                  className={`${styles.accordionIconBadge} ${ACCORDION_ICON_CLASSES[section.id]}`}
                >
                  <AccordionSectionIcon sectionId={section.id} />
                </span>
                <span>
                  {section.label}{" "}
                  <span className={styles.accordionTriggerCount}>
                    ({getSectionCount(section.id, tenant)})
                  </span>
                </span>
              </span>
              <AccordionChevron open={open} />
            </button>

            {open && (
              <div className={`${styles.accordionPanel} ${styles.connectionsAccordionPanel}`}>
                {renderSectionContent(section.id)}
              </div>
            )}
          </section>
        );
      })}
    </>
  );
}
