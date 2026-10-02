"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { SelectMetaPageModal } from "@/components/channels/select-meta-page-modal";
import type { SocialChannelStatus, WorkspaceChannels } from "@/lib/channels/workspace-channels";
import {
  completeMetaPageConnectionAction,
  disconnectMetaChannelAction,
  ensureMetaPageWebhooksAction,
  listMetaPagesForTenantAction,
} from "@/lib/meta/meta-actions";
import type { MetaChannel } from "@/lib/meta/oauth";
import type { MetaPageOption } from "@/lib/meta/pages";
import { formatPhoneDisplay } from "@/lib/phone-display";
import styles from "@/components/shell/shell.module.css";

const CHANNEL_COPY: Record<MetaChannel, { name: string; icon: string; detail: string }> = {
  messenger: {
    name: "Facebook",
    icon: "/integrations/facebook.png",
    detail: "Messenger conversations and comments on your Page posts",
  },
  instagram: {
    name: "Instagram",
    icon: "/integrations/instagram.png",
    detail: "Direct messages and comments on your posts",
  },
};

const FLASH_PARAMS = ["meta_error", "meta_connected", "meta_select_page"];

function flashFromParams(params: URLSearchParams): { kind: "success" | "error"; text: string } | null {
  const error = params.get("meta_error");
  if (error === "not_configured") {
    return { kind: "error", text: "Meta is not configured yet. Contact REOS support." };
  }
  if (error) return { kind: "error", text: error };
  const connected = params.get("meta_connected");
  if (connected === "messenger" || connected === "instagram") {
    return { kind: "success", text: `${CHANNEL_COPY[connected].name} connected.` };
  }
  return null;
}

function statusLine(status: SocialChannelStatus): string {
  if (status.awaitingPageSelection) {
    return status.channel === "instagram"
      ? "Select the Page linked to your Instagram account to finish"
      : "Select a Facebook Page to finish";
  }
  if (status.status === "connected") return status.accountLabel || "Connected";
  if (status.status === "error") return "Connection error. Reconnect to fix it.";
  return CHANNEL_COPY[status.channel].detail;
}

function ReadyCheck() {
  return (
    <span className={styles.connectionReadyCheck} aria-label="Connected">
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

export function ChannelsSettings({
  tenantId,
  channels,
}: {
  tenantId: string;
  channels: WorkspaceChannels;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [flash] = useState(() => flashFromParams(new URLSearchParams(searchParams.toString())));
  const [error, setError] = useState<string | null>(null);
  const [pickerChannel, setPickerChannel] = useState<MetaChannel | null>(null);
  const [pages, setPages] = useState<MetaPageOption[]>([]);
  const [pagesLoading, setPagesLoading] = useState(false);
  const [pickerError, setPickerError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const pickerChecked = useRef(false);

  useEffect(() => {
    if (pickerChecked.current) return;
    pickerChecked.current = true;

    const requested = searchParams.get("meta_select_page");
    const awaiting =
      requested === "messenger" || requested === "instagram"
        ? requested
        : channels.social.find((entry) => entry.awaitingPageSelection)?.channel;
    if (awaiting) void openPicker(awaiting);

    if (FLASH_PARAMS.some((key) => searchParams.has(key))) {
      const next = new URLSearchParams(searchParams.toString());
      for (const key of FLASH_PARAMS) next.delete(key);
      const query = next.toString();
      router.replace(query ? `${pathname}?${query}` : pathname, { scroll: false });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    for (const status of channels.social) {
      if (status.status === "connected" && !status.awaitingPageSelection && status.externalPageId) {
        void ensureMetaPageWebhooksAction(tenantId, status.channel);
      }
    }
  }, [channels, tenantId]);

  async function openPicker(channel: MetaChannel) {
    setPickerChannel(channel);
    setPickerError(null);
    setPages([]);
    setPagesLoading(true);
    const result = await listMetaPagesForTenantAction(tenantId, channel);
    setPagesLoading(false);
    if (!result.ok) {
      setPickerError(result.error);
      return;
    }
    setPages(result.pages);
  }

  function closePicker() {
    setPickerChannel(null);
    setPages([]);
    setPickerError(null);
    setPagesLoading(false);
  }

  function confirmPage(pageId: string) {
    if (!pickerChannel) return;
    const formData = new FormData();
    formData.set("tenantId", tenantId);
    formData.set("channel", pickerChannel);
    formData.set("pageId", pageId);

    startTransition(async () => {
      const result = await completeMetaPageConnectionAction(formData);
      if (!result.ok) {
        setPickerError(result.error ?? "Could not connect the Facebook Page.");
        return;
      }
      closePicker();
      router.refresh();
    });
  }

  function connect(channel: MetaChannel) {
    window.location.href = `/api/oauth/meta/start?channel=${channel}&returnTo=settings`;
  }

  function disconnect(channel: MetaChannel) {
    const name = CHANNEL_COPY[channel].name;
    if (
      !window.confirm(
        `Disconnect ${name}? The conversation agent stops replying on ${name} until it is reconnected.`,
      )
    ) {
      return;
    }
    setError(null);
    startTransition(async () => {
      const result = await disconnectMetaChannelAction(tenantId, channel);
      if (!result.ok) {
        setError(result.error ?? `Could not disconnect ${name}.`);
        return;
      }
      router.refresh();
    });
  }

  return (
    <>
      <SelectMetaPageModal
        open={pickerChannel !== null}
        channel={pickerChannel ?? "messenger"}
        pages={pages}
        loading={pagesLoading}
        pending={pending}
        error={pickerError}
        onClose={() => {
          if (!pending) closePicker();
        }}
        onConfirm={confirmPage}
      />

      <div className={styles.settingsStack}>
        <section className={styles.settingsSection}>
          <h2 className={styles.settingsSectionTitle}>Social channels</h2>
          <p className={styles.settingsSectionDesc}>
            Connect the accounts your conversation agent answers on. These connections are shared
            by everyone in this workspace.
          </p>

          {flash ? (
            <p className={flash.kind === "success" ? styles.success : styles.error}>{flash.text}</p>
          ) : null}
          {error ? <p className={styles.error}>{error}</p> : null}

          <ul className={styles.connectionsList}>
            {channels.social.map((status) => {
              const copy = CHANNEL_COPY[status.channel];
              const awaiting = status.awaitingPageSelection;
              const connected = status.status === "connected" && !awaiting;

              return (
                <li key={status.channel} className={styles.connectionRow}>
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={copy.icon} alt="" aria-hidden="true" className={styles.connectionBrandIcon} />
                  <div className={styles.connectionMeta}>
                    <span className={styles.connectionName}>{copy.name}</span>
                    <span className={styles.connectionDesc}>
                      {connected ? (
                        <span className={styles.connectionDescRow}>
                          <span>{statusLine(status)}</span>
                          <ReadyCheck />
                        </span>
                      ) : (
                        statusLine(status)
                      )}
                    </span>
                  </div>
                  <div className={styles.connectionDescRow}>
                    {awaiting ? (
                      <button
                        type="button"
                        className={`${styles.connectionTextBtn} ${styles.connectionTextBtnConnect}`}
                        disabled={pending}
                        onClick={() => void openPicker(status.channel)}
                      >
                        Select page
                      </button>
                    ) : connected ? (
                      <button
                        type="button"
                        className={`${styles.connectionTextBtn} ${styles.connectionTextBtnDisconnect}`}
                        disabled={pending}
                        onClick={() => connect(status.channel)}
                      >
                        Reconnect
                      </button>
                    ) : (
                      <button
                        type="button"
                        className={`${styles.connectionTextBtn} ${styles.connectionTextBtnConnect}`}
                        aria-label={`Connect ${copy.name}`}
                        disabled={pending}
                        onClick={() => connect(status.channel)}
                      >
                        Connect
                      </button>
                    )}
                    {status.status === "connected" ? (
                      <button
                        type="button"
                        className={`${styles.connectionTextBtn} ${styles.connectionTextBtnDisconnect}`}
                        aria-label={`Disconnect ${copy.name}`}
                        disabled={pending}
                        onClick={() => disconnect(status.channel)}
                      >
                        Disconnect
                      </button>
                    ) : null}
                  </div>
                </li>
              );
            })}
          </ul>
        </section>

        <section className={styles.settingsSection}>
          <h2 className={styles.settingsSectionTitle}>Text messaging</h2>
          <p className={styles.settingsSectionDesc}>
            Your SMS number is provisioned by REOS. Contact support to add or change it.
          </p>
          <ul className={styles.connectionsList}>
            <li className={styles.connectionRow}>
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src="/integrations/telnyx.png"
                alt=""
                aria-hidden="true"
                className={styles.connectionBrandIcon}
              />
              <div className={styles.connectionMeta}>
                <span className={styles.connectionName}>SMS</span>
                <span className={styles.connectionDesc}>
                  {channels.smsNumber ? (
                    <span className={styles.connectionDescRow}>
                      <span>{formatPhoneDisplay(channels.smsNumber)}</span>
                      <ReadyCheck />
                    </span>
                  ) : (
                    "No number assigned yet"
                  )}
                </span>
              </div>
            </li>
          </ul>
        </section>
      </div>
    </>
  );
}
