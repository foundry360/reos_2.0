"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import {
  disconnectTenantBillingAction,
  disconnectTenantChannelAction,
  disconnectTenantPrimaryPhoneAction,
  linkTenantStripeCustomerAction,
  updateTenantAgentToggleAction,
} from "@/lib/admin/tenant-config-actions";
import { formatPhoneDisplay } from "@/lib/phone-display";
import type { TenantChannelStatus, TenantConfig } from "@/lib/admin/tenant-config";
import { ConnectStripeModal } from "./connect-stripe-modal";
import styles from "@/components/shell/shell.module.css";

interface AccountConnectionsSectionsProps {
  tenant: TenantConfig;
}

type ConnectionSection = "connected" | "social";

const SECTIONS: { id: ConnectionSection; label: string }[] = [
  { id: "connected", label: "Connected channels" },
  { id: "social", label: "Social channels" },
];

type SocialChannel = "messenger" | "instagram";
type ConnectedIntegrationChannel = "email" | "calendar";

const SOCIAL_CHANNELS: SocialChannel[] = ["messenger", "instagram"];
const CONNECTED_INTEGRATION_CHANNELS: ConnectedIntegrationChannel[] = ["email", "calendar"];

const INTEGRATION_CHANNEL_LABELS: Record<ConnectedIntegrationChannel, string> = {
  email: "Gmail",
  calendar: "Google Calendar",
};

const INTEGRATION_CHANNEL_DESCRIPTIONS: Record<ConnectedIntegrationChannel, string> = {
  email: "Connect the tenant's Gmail inbox",
  calendar: "Connect Google Calendar for scheduling",
};

function ConnectionReadyCheck() {
  return (
    <span className={styles.connectionReadyCheck} aria-label="Ready for usage billing">
      <svg width="10" height="10" viewBox="0 0 24 24" fill="none" aria-hidden="true">
        <path
          d="M5 12l5 5 9-9"
          stroke="currentColor"
          strokeWidth="3"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    </span>
  );
}

function ConnectionButton({
  connected,
  name,
  pending,
  onConnect,
  onDisconnect,
}: {
  connected: boolean;
  name: string;
  pending?: boolean;
  onConnect: () => void;
  onDisconnect: () => void;
}) {
  if (connected) {
    return (
      <button
        type="button"
        className={`${styles.connectionTextBtn} ${styles.connectionTextBtnDisconnect}`}
        aria-label={`Disconnect ${name}`}
        disabled={pending}
        onClick={onDisconnect}
      >
        Disconnect
      </button>
    );
  }

  return (
    <button
      type="button"
      className={`${styles.connectionTextBtn} ${styles.connectionTextBtnConnect}`}
      aria-label={`Connect ${name}`}
      disabled={pending}
      onClick={onConnect}
    >
      Connect
    </button>
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

function getChannelStatus(
  tenant: TenantConfig,
  channel: ConnectedIntegrationChannel | SocialChannel,
): TenantChannelStatus {
  return (
    tenant.channelAccounts.find((entry) => entry.channel === channel) ?? {
      channel,
      status: "disconnected",
      accountLabel: null,
    }
  );
}

function getConnectedChannelCount(tenant: TenantConfig): number {
  let count = 0;
  if (tenant.primaryPhone) count++;
  if (tenant.agents.conciergeEnabled) count++;
  if (tenant.agents.intakeEnabled) count++;
  if (tenant.stripeBillingReady) count++;
  for (const channel of CONNECTED_INTEGRATION_CHANNELS) {
    if (getChannelStatus(tenant, channel).status === "connected") count++;
  }
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

function integrationChannelMeta(channel: TenantChannelStatus): string {
  if (channel.status === "connected" && channel.accountLabel) {
    return channel.accountLabel;
  }
  if (channel.status === "error") return "Connection error";
  return "Not connected";
}

function socialChannelMeta(channel: TenantChannelStatus): string {
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
  const [stripeModalOpen, setStripeModalOpen] = useState(false);
  const [stripeLinkError, setStripeLinkError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const twilioConnected = Boolean(tenant.primaryPhone);
  const stripeLinked = Boolean(tenant.stripeCustomerId);
  const stripeConnected = tenant.stripeBillingReady;

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

  function runAction(action: () => Promise<{ ok: boolean; error?: string }>) {
    startTransition(async () => {
      const result = await action();
      if (!result.ok) {
        window.alert(result.error ?? "Could not update connection.");
        return;
      }
      router.refresh();
    });
  }

  function setAgentEnabled(field: "conciergeEnabled" | "intakeEnabled", enabled: boolean) {
    const formData = new FormData();
    formData.set("tenantId", tenant.id);
    formData.set("field", field);
    formData.set("enabled", String(enabled));
    runAction(() => updateTenantAgentToggleAction(formData));
  }

  function disconnectChannel(channel: ConnectedIntegrationChannel | SocialChannel) {
    const formData = new FormData();
    formData.set("tenantId", tenant.id);
    formData.set("channel", channel);
    runAction(() => disconnectTenantChannelAction(formData));
  }

  function connectIntegrationChannel(channel: ConnectedIntegrationChannel) {
    window.location.href = `/api/oauth/google/start?tenantId=${encodeURIComponent(tenant.id)}&channel=${channel}`;
  }

  function connectSocialChannel(channel: SocialChannel) {
    window.location.href = `/api/oauth/meta/start?tenantId=${encodeURIComponent(tenant.id)}&channel=${channel}`;
  }

  function connectTwilio() {
    document.querySelector(`.${styles.highlightsPanel}`)?.scrollIntoView({ behavior: "smooth" });
    window.alert("Add a phone number in Highlights to connect Twilio SMS.");
  }

  function disconnectTwilio() {
    if (!window.confirm("Remove the Twilio SMS number from this account?")) return;

    const formData = new FormData();
    formData.set("tenantId", tenant.id);
    runAction(() => disconnectTenantPrimaryPhoneAction(formData));
  }

  function connectBilling() {
    setStripeLinkError(null);
    setStripeModalOpen(true);
  }

  function confirmLinkBilling(stripeCustomerId: string) {
    const formData = new FormData();
    formData.set("tenantId", tenant.id);
    formData.set("stripeCustomerId", stripeCustomerId);

    startTransition(async () => {
      const result = await linkTenantStripeCustomerAction(formData);
      if (!result.ok) {
        setStripeLinkError(result.error ?? "Could not link Stripe customer.");
        return;
      }

      setStripeModalOpen(false);
      setStripeLinkError(null);
      router.refresh();
    });
  }

  function disconnectBilling() {
    if (!window.confirm("Remove the billing customer from this account?")) return;

    const formData = new FormData();
    formData.set("tenantId", tenant.id);
    runAction(() => disconnectTenantBillingAction(formData));
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
          <ConnectionButton
            connected={twilioConnected}
            name="Twilio SMS"
            pending={pending}
            onConnect={connectTwilio}
            onDisconnect={disconnectTwilio}
          />
        </li>

        {CONNECTED_INTEGRATION_CHANNELS.map((channel) => {
          const status = getChannelStatus(tenant, channel);
          const connected = status.status === "connected";
          const label = INTEGRATION_CHANNEL_LABELS[channel];

          return (
            <li key={channel} className={styles.connectionRow}>
              <div className={styles.connectionMeta}>
                <span className={styles.connectionName}>{label}</span>
                <span className={styles.connectionDesc}>
                  {connected
                    ? integrationChannelMeta(status)
                    : INTEGRATION_CHANNEL_DESCRIPTIONS[channel]}
                </span>
              </div>
              <ConnectionButton
                connected={connected}
                name={label}
                pending={pending}
                onConnect={() => connectIntegrationChannel(channel)}
                onDisconnect={() => disconnectChannel(channel)}
              />
            </li>
          );
        })}

        <li className={styles.connectionRow}>
          <div className={styles.connectionMeta}>
            <span className={styles.connectionName}>AI Concierge</span>
            <span className={styles.connectionDesc}>
              {tenant.agents.conciergeEnabled ? "Enabled" : "Inbound SMS agent responses"}
            </span>
          </div>
          <ConnectionButton
            connected={tenant.agents.conciergeEnabled}
            name="AI Concierge"
            pending={pending}
            onConnect={() => setAgentEnabled("conciergeEnabled", true)}
            onDisconnect={() => setAgentEnabled("conciergeEnabled", false)}
          />
        </li>

        <li className={styles.connectionRow}>
          <div className={styles.connectionMeta}>
            <span className={styles.connectionName}>Intake</span>
            <span className={styles.connectionDesc}>
              {tenant.agents.intakeEnabled ? "Enabled" : "Create contacts from new leads"}
            </span>
          </div>
          <ConnectionButton
            connected={tenant.agents.intakeEnabled}
            name="Intake"
            pending={pending}
            onConnect={() => setAgentEnabled("intakeEnabled", true)}
            onDisconnect={() => setAgentEnabled("intakeEnabled", false)}
          />
        </li>

        <li className={styles.connectionRow}>
          <div className={styles.connectionMeta}>
            <span className={styles.connectionName}>Stripe</span>
            <span className={styles.connectionDesc}>
              {stripeConnected ? (
                <span className={styles.connectionDescRow}>
                  <span>{tenant.stripeCustomerId}</span>
                  <ConnectionReadyCheck />
                </span>
              ) : stripeLinked ? (
                <>
                  {tenant.stripeCustomerId}
                  <span className={styles.connectionDescWarning}> · no payment method on file</span>
                </>
              ) : (
                "Link the Stripe customer from GHL setup payment"
              )}
            </span>
          </div>
          <ConnectionButton
            connected={stripeLinked}
            name="Stripe"
            pending={pending}
            onConnect={connectBilling}
            onDisconnect={disconnectBilling}
          />
        </li>
      </ul>
    );
  }

  function renderSocialChannels() {
    return (
      <ul className={styles.connectionsList}>
        {SOCIAL_CHANNELS.map((channel) => {
          const status = getChannelStatus(tenant, channel);
          const connected = status.status === "connected";
          const label = channel === "messenger" ? "Facebook Messenger" : "Instagram";

          return (
            <li key={channel} className={styles.connectionRow}>
              <div className={styles.connectionMeta}>
                <span className={styles.connectionName}>{label}</span>
                <span className={styles.connectionDesc}>{socialChannelMeta(status)}</span>
              </div>
              <ConnectionButton
                connected={connected}
                name={label}
                pending={pending}
                onConnect={() => connectSocialChannel(channel)}
                onDisconnect={() => disconnectChannel(channel)}
              />
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
      <ConnectStripeModal
        open={stripeModalOpen}
        pending={pending}
        error={stripeLinkError}
        onClose={() => {
          if (pending) return;
          setStripeModalOpen(false);
          setStripeLinkError(null);
        }}
        onConfirm={confirmLinkBilling}
      />

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
