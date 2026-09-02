"use client";

import { useEffect, useMemo, useRef, useState, useTransition } from "react";
import {
  sendPersonMessageAction,
  type MessagingChannel,
} from "@/lib/messaging/send-person-message-action";
import { createClient } from "@/lib/supabase/client";
import { accountInitials } from "@/lib/user-display";
import type {
  PersonMessage,
  PersonMessagingChannelOption,
  PersonEmail,
} from "../_lib/person-detail-types";
import { PersonEmailPanel } from "./person-email-panel";
import styles from "@/components/shell/shell.module.css";

type ChannelFilter = "all" | "messenger" | "instagram" | "email";

function channelLabel(channel: string): string {
  switch (channel) {
    case "sms":
      return "SMS";
    case "messenger":
      return "Messenger";
    case "instagram":
      return "Instagram";
    case "email":
      return "Email";
    default:
      return channel;
  }
}

function formatMessageTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(date);
}

function pickSendChannel(
  filter: ChannelFilter,
  channels: PersonMessagingChannelOption[],
  messages: PersonMessage[],
): MessagingChannel | null {
  const available = channels.filter((entry) => entry.available);
  if (available.length === 0) return null;

  if (filter === "messenger" || filter === "instagram") {
    return available.find((entry) => entry.channel === filter)?.channel ?? null;
  }

  const last = [...messages].reverse().find((message) =>
    available.some((entry) => entry.channel === message.channel),
  );
  if (last) return last.channel as MessagingChannel;

  const preferred = (["messenger", "instagram", "sms"] as const).find((channel) =>
    available.some((entry) => entry.channel === channel),
  );
  return preferred ?? available[0]?.channel ?? null;
}

function mapMessageRow(row: {
  id: string;
  channel: string;
  direction: string;
  body: string;
  created_at: string;
}): PersonMessage | null {
  if (row.direction !== "inbound" && row.direction !== "outbound") return null;
  return {
    id: row.id,
    channel: row.channel,
    direction: row.direction,
    body: row.body,
    createdAt: row.created_at,
  };
}

function mapRealtimeMessage(row: Record<string, unknown>): PersonMessage | null {
  const id = typeof row.id === "string" ? row.id : null;
  const channel = typeof row.channel === "string" ? row.channel : null;
  const direction =
    row.direction === "inbound" || row.direction === "outbound"
      ? row.direction
      : null;
  const body = typeof row.body === "string" ? row.body : null;
  const createdAt =
    typeof row.created_at === "string"
      ? row.created_at
      : row.created_at instanceof Date
        ? row.created_at.toISOString()
        : null;

  if (!id || !channel || !direction || !body || !createdAt) return null;
  return { id, channel, direction, body, createdAt };
}

function mergeMessages(
  current: PersonMessage[],
  incoming: PersonMessage[],
): PersonMessage[] {
  if (incoming.length === 0) return current;
  const byId = new Map(current.map((message) => [message.id, message]));
  let changed = false;
  for (const message of incoming) {
    const prev = byId.get(message.id);
    if (
      !prev ||
      prev.body !== message.body ||
      prev.createdAt !== message.createdAt ||
      prev.direction !== message.direction
    ) {
      changed = true;
    }
    byId.set(message.id, message);
  }
  if (!changed && byId.size === current.length) return current;
  return [...byId.values()].sort(
    (a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime(),
  );
}

function replaceOptimistic(
  current: PersonMessage[],
  next: PersonMessage,
): PersonMessage[] {
  const withoutOptimistic = current.filter((message) => {
    if (!message.id.startsWith("optimistic:")) return true;
    return !(
      message.direction === next.direction &&
      message.channel === next.channel &&
      message.body === next.body
    );
  });
  return mergeMessages(withoutOptimistic, [next]);
}

function IconMessengerBadge() {
  return (
    <svg viewBox="0 0 24 24" width="100%" height="100%" aria-hidden="true">
      <circle cx="12" cy="12" r="12" fill="#0866FF" />
      <path
        d="M12 4.8c-3.9 0-7 2.85-7 6.36 0 2 .98 3.78 2.52 4.95V19l2.3-1.26c.7.2 1.43.3 2.18.3 3.9 0 7-2.85 7-6.36S15.9 4.8 12 4.8zm.7 8.56-1.8-1.92-3.5 1.92 3.86-4.1 1.84 1.92 3.46-1.92-3.86 4.1z"
        fill="#fff"
      />
    </svg>
  );
}

function PlatformBadge({ channel }: { channel: string }) {
  if (channel === "messenger") {
    return (
      <span className={styles.personMessagePlatformBadge} title="Messenger">
        <IconMessengerBadge />
      </span>
    );
  }
  if (channel === "instagram") {
    return (
      <span className={styles.personMessagePlatformBadge} title="Instagram">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src="/integrations/instagram.png" alt="" />
      </span>
    );
  }
  if (channel === "sms") {
    return (
      <span
        className={`${styles.personMessagePlatformBadge} ${styles.personMessagePlatformBadgeSms}`}
        title="SMS"
      >
        SMS
      </span>
    );
  }
  return null;
}

function MessageAvatar({
  name,
  channel,
  tone,
  imageUrl,
}: {
  name: string;
  channel: string;
  tone: "contact" | "agent";
  imageUrl?: string | null;
}) {
  const showPhoto = Boolean(imageUrl);
  return (
    <div className={styles.personMessageAvatarWrap}>
      {showPhoto ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={imageUrl!}
          alt=""
          className={`${styles.avatar} ${styles.personMessageAvatar} ${styles.personMessageAvatarImg} ${
            tone === "agent" ? styles.personMessageAvatarAgentImg : ""
          }`}
        />
      ) : (
        <span
          className={`${styles.avatar} ${styles.personMessageAvatar} ${
            tone === "agent" ? styles.personMessageAvatarAgent : ""
          }`}
        >
          {accountInitials(name)}
        </span>
      )}
      <PlatformBadge channel={channel} />
    </div>
  );
}

function IconChannel() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path
        d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function IconChevron({ open }: { open: boolean }) {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      aria-hidden="true"
      className={open ? styles.personMessagingChannelChevronOpen : undefined}
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

export function PersonMessagingPanel({
  contactId,
  personName,
  contactEmail,
  avatarUrl,
  agentName,
  agentAvatarUrl,
  messages: initialMessages,
  channels,
  emails: initialEmails,
  emailConnected,
  opportunityId,
  opportunityName,
}: {
  contactId: string;
  personName: string;
  contactEmail: string | null;
  avatarUrl?: string | null;
  agentName?: string;
  agentAvatarUrl?: string | null;
  messages: PersonMessage[];
  channels: PersonMessagingChannelOption[];
  emails: PersonEmail[];
  emailConnected: boolean;
  opportunityId?: string | null;
  opportunityName?: string | null;
}) {
  const threadRef = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const latestCreatedAtRef = useRef<string | null>(null);
  const stickToBottomRef = useRef(true);
  const [pending, startTransition] = useTransition();
  const [draft, setDraft] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<ChannelFilter>("all");
  const [menuOpen, setMenuOpen] = useState(false);
  const [messages, setMessages] = useState(initialMessages);
  const [emails, setEmails] = useState(initialEmails);

  useEffect(() => {
    setMessages((current) => mergeMessages(current, initialMessages));
  }, [initialMessages]);

  useEffect(() => {
    setEmails(initialEmails);
  }, [initialEmails]);

  useEffect(() => {
    const newest = messages[messages.length - 1]?.createdAt ?? null;
    if (
      newest &&
      (!latestCreatedAtRef.current ||
        new Date(newest).getTime() >= new Date(latestCreatedAtRef.current).getTime())
    ) {
      latestCreatedAtRef.current = newest;
    }
  }, [messages]);

  // Live updates: Realtime (after JWT is set) + light poll while the tab is open.
  useEffect(() => {
    const supabase = createClient();
    let cancelled = false;
    let channel: ReturnType<typeof supabase.channel> | null = null;

    async function pullNewer() {
      if (cancelled) return;
      let query = supabase
        .from("messages")
        .select("id, channel, direction, body, created_at")
        .eq("contact_id", contactId)
        .order("created_at", { ascending: true })
        .limit(100);

      if (latestCreatedAtRef.current) {
        query = query.gte("created_at", latestCreatedAtRef.current);
      }

      const { data, error: queryError } = await query;
      if (cancelled || queryError || !data) return;

      const mapped = data
        .map(mapMessageRow)
        .filter((row): row is PersonMessage => Boolean(row));
      if (mapped.length === 0) return;
      setMessages((current) => {
        let next = current;
        for (const row of mapped) {
          next = replaceOptimistic(next, row);
        }
        return next;
      });
    }

    async function start() {
      const { data } = await supabase.auth.getSession();
      const token = data.session?.access_token;
      if (token) {
        await supabase.realtime.setAuth(token);
      }

      if (cancelled) return;

      channel = supabase
        .channel(`person-messages:${contactId}`)
        .on(
          "postgres_changes",
          {
            event: "INSERT",
            schema: "public",
            table: "messages",
            filter: `contact_id=eq.${contactId}`,
          },
          (payload) => {
            const next = mapRealtimeMessage(
              payload.new as Record<string, unknown>,
            );
            if (!next) return;
            setMessages((current) => replaceOptimistic(current, next));
          },
        )
        .subscribe((status) => {
          if (status === "SUBSCRIBED") {
            void pullNewer();
          } else if (status === "CHANNEL_ERROR" || status === "TIMED_OUT") {
            console.warn("Messaging realtime status:", status);
          }
        });
    }

    void start();
    void pullNewer();

    const pollId = window.setInterval(() => {
      if (document.visibilityState === "visible") {
        void pullNewer();
      }
    }, 2500);

    const onVisible = () => {
      if (document.visibilityState === "visible") void pullNewer();
    };
    document.addEventListener("visibilitychange", onVisible);

    return () => {
      cancelled = true;
      window.clearInterval(pollId);
      document.removeEventListener("visibilitychange", onVisible);
      if (channel) void supabase.removeChannel(channel);
    };
  }, [contactId]);

  const messenger = channels.find((entry) => entry.channel === "messenger");
  const instagram = channels.find((entry) => entry.channel === "instagram");

  const sendChannel = useMemo(
    () => pickSendChannel(filter, channels, messages),
    [filter, channels, messages],
  );

  const visibleMessages = useMemo(() => {
    if (filter === "all") return messages;
    return messages.filter((message) => message.channel === filter);
  }, [filter, messages]);

  useEffect(() => {
    const node = threadRef.current;
    if (!node || !stickToBottomRef.current) return;
    node.scrollTop = node.scrollHeight;
  }, [visibleMessages, filter]);

  function onThreadScroll() {
    const node = threadRef.current;
    if (!node) return;
    const distanceFromBottom =
      node.scrollHeight - node.scrollTop - node.clientHeight;
    stickToBottomRef.current = distanceFromBottom < 96;
  }

  useEffect(() => {
    if (!menuOpen) return;

    function onPointerDown(event: MouseEvent) {
      if (!menuRef.current?.contains(event.target as Node)) {
        setMenuOpen(false);
      }
    }

    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") setMenuOpen(false);
    }

    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [menuOpen]);

  const canSend = Boolean(sendChannel && draft.trim() && !pending);

  function selectFilter(next: ChannelFilter) {
    setFilter(next);
    setMenuOpen(false);
    setError(null);
    stickToBottomRef.current = true;
  }

  function send() {
    if (!sendChannel || !draft.trim() || pending) return;
    stickToBottomRef.current = true;
    const body = draft.trim();
    const optimisticId = `optimistic:${Date.now()}`;
    const optimistic: PersonMessage = {
      id: optimisticId,
      channel: sendChannel,
      direction: "outbound",
      body,
      createdAt: new Date().toISOString(),
    };

    setError(null);
    setDraft("");
    setMessages((current) => mergeMessages(current, [optimistic]));

    startTransition(async () => {
      const result = await sendPersonMessageAction({
        contactId,
        channel: sendChannel,
        body,
      });
      if (!result.ok) {
        setMessages((current) =>
          current.filter((message) => message.id !== optimisticId),
        );
        setDraft(body);
        setError(result.error ?? "Could not send message.");
        return;
      }

      if (result.messageId) {
        setMessages((current) =>
          replaceOptimistic(current, {
            id: result.messageId!,
            channel: sendChannel,
            direction: "outbound",
            body,
            createdAt: new Date().toISOString(),
          }),
        );
      }
    });
  }

  const filterLabel =
    filter === "all" ? "All channels" : channelLabel(filter);

  return (
    <section className={styles.personMessagingPanel}>
      <div className={styles.personMessagingPanelHeader}>
        <div className={styles.personMessagingPerson}>
          {avatarUrl ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={avatarUrl}
              alt=""
              className={`${styles.avatar} ${styles.personMessagingAvatar} ${styles.personMessageAvatarImg}`}
            />
          ) : (
            <span className={`${styles.avatar} ${styles.personMessagingAvatar}`}>
              {accountInitials(personName)}
            </span>
          )}
          <h2 className={styles.personMessagingPersonName}>{personName}</h2>
        </div>

        <div className={styles.personMessagingChannelMenu} ref={menuRef}>
          <button
            type="button"
            className={styles.personMessagingChannelTrigger}
            aria-haspopup="dialog"
            aria-expanded={menuOpen}
            aria-label={`Channel filter: ${filterLabel}`}
            title={filterLabel}
            onClick={() => setMenuOpen((open) => !open)}
          >
            <IconChannel />
            <IconChevron open={menuOpen} />
          </button>

          {menuOpen ? (
            <div className={styles.personMessagingChannelDialog} role="dialog" aria-label="Channel">
              <button
                type="button"
                className={`${styles.personMessagingChannelOption} ${
                  filter === "all" ? styles.personMessagingChannelOptionActive : ""
                }`}
                onClick={() => selectFilter("all")}
              >
                All
              </button>
              <button
                type="button"
                className={`${styles.personMessagingChannelOption} ${
                  filter === "messenger" ? styles.personMessagingChannelOptionActive : ""
                }`}
                disabled={!messenger?.connected}
                onClick={() => selectFilter("messenger")}
              >
                Messenger
              </button>
              <button
                type="button"
                className={`${styles.personMessagingChannelOption} ${
                  filter === "instagram" ? styles.personMessagingChannelOptionActive : ""
                }`}
                disabled={!instagram?.connected}
                onClick={() => selectFilter("instagram")}
              >
                Instagram
              </button>
              <button
                type="button"
                className={`${styles.personMessagingChannelOption} ${
                  filter === "email" ? styles.personMessagingChannelOptionActive : ""
                }`}
                onClick={() => selectFilter("email")}
              >
                Email
              </button>
            </div>
          ) : null}
        </div>
      </div>

      {filter === "email" ? (
        <PersonEmailPanel
          contactId={contactId}
          contactEmail={contactEmail}
          emails={emails}
          emailConnected={emailConnected}
          personName={personName}
          avatarUrl={avatarUrl}
          agentName={agentName}
          agentAvatarUrl={agentAvatarUrl}
          opportunityId={opportunityId}
          opportunityName={opportunityName}
        />
      ) : (
        <>
      <div
        ref={threadRef}
        className={styles.personMessagingThread}
        onScroll={onThreadScroll}
      >
        {visibleMessages.length > 0 ? (
          visibleMessages.map((message) => {
            const inbound = message.direction === "inbound";
            return (
              <div
                key={message.id}
                className={`${styles.personMessageRow} ${
                  inbound ? styles.personMessageRowInbound : styles.personMessageRowOutbound
                }`}
              >
                {inbound ? (
                  <MessageAvatar
                    name={personName}
                    channel={message.channel}
                    tone="contact"
                    imageUrl={
                      message.channel === "messenger" || message.channel === "instagram"
                        ? avatarUrl
                        : null
                    }
                  />
                ) : null}
                <div
                  className={`${styles.personMessageBubble} ${
                    inbound
                      ? styles.personMessageBubbleInbound
                      : styles.personMessageBubbleOutbound
                  }`}
                >
                  <p className={styles.personMessageBody}>{message.body}</p>
                  <div className={styles.personMessageMeta}>
                    <span>{formatMessageTime(message.createdAt)}</span>
                  </div>
                </div>
                {!inbound ? (
                  <MessageAvatar
                    name={
                      channels.find((entry) => entry.channel === message.channel)?.label ||
                      agentName?.trim() ||
                      "You"
                    }
                    channel={message.channel}
                    tone="agent"
                    imageUrl={
                      channels.find((entry) => entry.channel === message.channel)
                        ?.pageAvatarUrl ||
                      (message.channel === "sms" ? agentAvatarUrl : null)
                    }
                  />
                ) : null}
              </div>
            );
          })
        ) : (
          <div className={styles.personMessagingEmpty}>
            <p className={styles.emptyStateTitle}>Start the conversation</p>
            <p className={styles.emptyStateDescription}>
              {filter === "all"
                ? "Send a message below. Messenger and Instagram threads show up here."
                : `No ${channelLabel(filter)} messages yet.`}
            </p>
          </div>
        )}
      </div>

      <div className={styles.personMessagingComposer}>
        {error ? <p className={styles.personMessagingError}>{error}</p> : null}
        {!sendChannel ? (
          <p className={styles.personMessagingHint}>
            {filter !== "all" && !channels.find((entry) => entry.channel === filter)?.connected
              ? `${channelLabel(filter)} is not connected for this account.`
              : filter !== "all"
                ? `This client has no ${channelLabel(filter)} thread yet.`
                : "No sendable channel yet. Connect Messenger or Instagram and wait for an inbound message."}
          </p>
        ) : (
          <div className={styles.personMessagingComposerRow}>
            <textarea
              className={styles.personMessagingInput}
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              placeholder={`Reply via ${channelLabel(sendChannel)}…`}
              rows={3}
              disabled={pending}
              onKeyDown={(event) => {
                if (event.key === "Enter" && !event.shiftKey) {
                  event.preventDefault();
                  send();
                }
              }}
            />
            <button
              type="button"
              className={styles.personMessagingSend}
              disabled={!canSend}
              onClick={send}
            >
              {pending ? "Sending…" : "Send"}
            </button>
          </div>
        )}
      </div>
        </>
      )}
    </section>
  );
}
