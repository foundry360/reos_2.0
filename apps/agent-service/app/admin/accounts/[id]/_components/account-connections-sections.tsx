"use client";

import { useEffect, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import {
  disconnectTenantBillingAction,
  disconnectTenantPrimaryPhoneAction,
  linkTenantStripeCustomerAction,
} from "@/lib/admin/tenant-config-actions";
import { ensureMetaPageWebhooksAction } from "@/lib/meta/meta-actions";
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

const SOCIAL_CHANNELS: SocialChannel[] = ["messenger", "instagram"];

const SOCIAL_CHANNEL_ICONS: Record<SocialChannel, string> = {
  messenger: "/integrations/facebook.png",
  instagram: "/integrations/instagram.png",
};

function ConnectionBrandIcon({
  src,
  label,
}: {
  src: string;
  label: string;
}) {
  return (
    // Brand marks for channel rows; decorative next to the text label.
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={src}
      alt=""
      aria-hidden="true"
      title={label}
      className={styles.connectionBrandIcon}
    />
  );
}

function ConnectionReadyCheck({ label = "Connected" }: { label?: string }) {
  return (
    <span className={styles.connectionReadyCheck} aria-label={label}>
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
  channel: SocialChannel,
): TenantChannelStatus {
  return (
    tenant.channelAccounts.find((entry) => entry.channel === channel) ?? {
      channel,
      status: "disconnected",
      accountLabel: null,
      externalPageId: null,
      awaitingPageSelection: false,
    }
  );
}

function getConnectedChannelCount(tenant: TenantConfig): number {
  let count = 0;
  if (tenant.primaryPhone) count++;
  if (tenant.stripeBillingReady) count++;
  return count;
}

function getConnectedSocialChannelCount(tenant: TenantConfig): number {
  return tenant.channelAccounts.filter(
    (entry) =>
      (entry.channel === "messenger" || entry.channel === "instagram") &&
      entry.status === "connected" &&
      !entry.awaitingPageSelection,
  ).length;
}

function getSectionCount(sectionId: ConnectionSection, tenant: TenantConfig): number {
  if (sectionId === "connected") return getConnectedChannelCount(tenant);
  return getConnectedSocialChannelCount(tenant);
}

function socialChannelMeta(channel: TenantChannelStatus): string {
  if (channel.awaitingPageSelection) {
    return "Waiting for the workspace owner to select a Page";
  }
  if (channel.status === "connected") {
    const label = channel.accountLabel?.trim();
    if (!label) return "Connected";
    return label.startsWith("@") ? label : label;
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

  const telnyxConnected = Boolean(tenant.primaryPhone);
  const stripeLinked = Boolean(tenant.stripeCustomerId);
  const stripeConnected = tenant.stripeBillingReady;

  useEffect(() => {
    for (const channel of SOCIAL_CHANNELS) {
      const status = getChannelStatus(tenant, channel);
      if (status.status === "connected" && !status.awaitingPageSelection && status.externalPageId) {
        void ensureMetaPageWebhooksAction(tenant.id, channel);
      }
    }
  }, [tenant]);

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

  function connectTelnyx() {
    document.querySelector(`.${styles.highlightsPanel}`)?.scrollIntoView({ behavior: "smooth" });
    window.alert("Add a phone number in Highlights to connect Telnyx SMS.");
  }

  function disconnectTelnyx() {
    if (!window.confirm("Remove the Telnyx SMS number from this account?")) return;

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
          <ConnectionBrandIcon
            src="/integrations/telnyx.png"
            label="Telnyx SMS"
          />
          <div className={styles.connectionMeta}>
            <span className={styles.connectionName}>Telnyx SMS</span>
            <span className={styles.connectionDesc}>
              {telnyxConnected
                ? formatPhoneDisplay(tenant.primaryPhone)
                : "Assign a phone number in Highlights"}
            </span>
          </div>
          <ConnectionButton
            connected={telnyxConnected}
            name="Telnyx SMS"
            pending={pending}
            onConnect={connectTelnyx}
            onDisconnect={disconnectTelnyx}
          />
        </li>

        <li className={styles.connectionRow}>
          <ConnectionBrandIcon src="/integrations/stripe.png" label="Stripe" />
          <div className={styles.connectionMeta}>
            <span className={styles.connectionName}>Stripe</span>
            <span className={styles.connectionDesc}>
              {stripeConnected ? (
                <span className={styles.connectionDescRow}>
                  <span>{tenant.stripeCustomerId}</span>
                  <ConnectionReadyCheck label="Ready for usage billing" />
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
      <>
        <ul className={styles.connectionsList}>
          {SOCIAL_CHANNELS.map((channel) => {
            const status = getChannelStatus(tenant, channel);
            const fullyConnected = status.status === "connected" && !status.awaitingPageSelection;
            const label = channel === "messenger" ? "Facebook Messenger" : "Instagram";

            return (
              <li key={channel} className={styles.connectionRow}>
                <ConnectionBrandIcon src={SOCIAL_CHANNEL_ICONS[channel]} label={label} />
                <div className={styles.connectionMeta}>
                  <span className={styles.connectionName}>{label}</span>
                  <span className={styles.connectionDesc}>
                    {fullyConnected ? (
                      <span className={styles.connectionDescRow}>
                        <span>{socialChannelMeta(status)}</span>
                        <ConnectionReadyCheck />
                      </span>
                    ) : (
                      socialChannelMeta(status)
                    )}
                  </span>
                </div>
              </li>
            );
          })}
        </ul>
        <p className={styles.connectionsFootnote}>
          Workspace owners connect social channels in Settings → Channels.
        </p>
      </>
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
