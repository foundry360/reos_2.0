"use client";

import { useEffect, useMemo, useState } from "react";
import type { PersonEmail } from "../_lib/person-detail-types";
import { EmptyState } from "@/components/shell/empty-state";
import { useEmailCompose } from "@/components/email/email-compose-provider";
import {
  conversationSubjectLabel,
  formatRecipientList,
  groupEmailsIntoConversations,
} from "@/lib/email/email-utils";
import { createClient } from "@/lib/supabase/client";
import { accountInitials } from "@/lib/user-display";
import styles from "@/components/email/email.module.css";
import shellStyles from "@/components/shell/shell.module.css";

function formatEmailTime(iso: string | null): string {
  if (!iso) return "";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(date);
}

function formatEmailTimeShort(iso: string | null): string {
  if (!iso) return "";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(date);
}

function IconChevron({ open }: { open: boolean }) {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      aria-hidden="true"
      className={open ? styles.emailThreadChevronOpen : styles.emailThreadChevron}
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

function mapEmailRow(row: {
  id: string;
  direction: string;
  from_email: string;
  from_name: string | null;
  to_recipients: unknown;
  cc_recipients: unknown;
  subject: string;
  body_html: string | null;
  body_text: string | null;
  snippet: string | null;
  sent_at: string | null;
  received_at: string | null;
  thread_id: string | null;
}): PersonEmail {
  return {
    id: row.id,
    direction: row.direction === "inbound" ? "inbound" : "outbound",
    fromEmail: row.from_email,
    fromName: row.from_name,
    toRecipients: Array.isArray(row.to_recipients) ? row.to_recipients : [],
    ccRecipients: Array.isArray(row.cc_recipients) ? row.cc_recipients : [],
    subject: row.subject,
    bodyHtml: row.body_html,
    bodyText: row.body_text,
    snippet: row.snippet,
    sentAt: row.sent_at,
    receivedAt: row.received_at,
    threadId: row.thread_id,
  };
}

function EmailEmptyState({
  title,
  description,
}: {
  title: string;
  description: string;
}) {
  return (
    <div className={shellStyles.personFeedEmptyState}>
      <EmptyState title={title} description={description} />
    </div>
  );
}

function EmailRowAvatar({
  name,
  imageUrl,
  tone,
}: {
  name: string;
  imageUrl?: string | null;
  tone: "contact" | "agent";
}) {
  const showPhoto = Boolean(imageUrl);

  return (
    <div className={shellStyles.personMessageAvatarWrap}>
      {showPhoto ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={imageUrl!}
          alt=""
          className={`${shellStyles.avatar} ${shellStyles.personMessageAvatar} ${shellStyles.personMessageAvatarImg} ${
            tone === "agent" ? shellStyles.personMessageAvatarAgentImg : ""
          }`}
        />
      ) : (
        <span
          className={`${shellStyles.avatar} ${shellStyles.personMessageAvatar} ${
            tone === "agent" ? shellStyles.personMessageAvatarAgent : ""
          }`}
        >
          {accountInitials(name)}
        </span>
      )}
      <span className={shellStyles.personMessagePlatformBadge} title="Email">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src="/integrations/gmail.png" alt="" />
      </span>
    </div>
  );
}

export function PersonEmailPanel({
  contactId,
  contactEmail,
  emails: initialEmails,
  emailConnected,
  personName,
  avatarUrl,
  agentName,
  agentAvatarUrl,
  opportunityId,
  opportunityName,
}: {
  contactId: string;
  contactEmail: string | null;
  emails: PersonEmail[];
  emailConnected: boolean;
  personName: string;
  avatarUrl?: string | null;
  agentName?: string;
  agentAvatarUrl?: string | null;
  opportunityId?: string | null;
  opportunityName?: string | null;
}) {
  const { openCompose } = useEmailCompose();
  const [expandedThreadId, setExpandedThreadId] = useState<string | null>(null);
  const [emails, setEmails] = useState(initialEmails);

  useEffect(() => {
    setEmails(initialEmails);
  }, [initialEmails]);

  // Poll for new emails saved to crm_emails (after send or inbound sync).
  useEffect(() => {
    if (!emailConnected) return;

    const supabase = createClient();
    let cancelled = false;

    async function pullEmails() {
      const { data, error } = await supabase
        .from("crm_emails")
        .select(
          "id, direction, from_email, from_name, to_recipients, cc_recipients, subject, body_html, body_text, snippet, sent_at, received_at, thread_id",
        )
        .eq("contact_id", contactId)
        .order("sent_at", { ascending: false, nullsFirst: false })
        .order("created_at", { ascending: false })
        .limit(100);

      if (cancelled || error || !data) return;
      setEmails(data.map(mapEmailRow));
    }

    void pullEmails();
    const pollId = window.setInterval(() => {
      if (document.visibilityState === "visible") void pullEmails();
    }, 4000);

    return () => {
      cancelled = true;
      window.clearInterval(pollId);
    };
  }, [contactId, emailConnected]);

  const threads = useMemo(() => groupEmailsIntoConversations(emails), [emails]);

  if (!contactEmail?.trim()) {
    return (
      <div className={`${styles.emailPanel} ${styles.emailPanelEmpty}`}>
        <EmailEmptyState
          title="No email address"
          description="Add an email address to this contact to send email from REOS."
        />
      </div>
    );
  }

  if (!emailConnected) {
    return (
      <div className={`${styles.emailPanel} ${styles.emailPanelEmpty}`}>
        <EmailEmptyState
          title="Connect Email"
          description="Connect Gmail in Admin → Accounts → Connections to send and track emails here."
        />
      </div>
    );
  }

  return (
    <div className={styles.emailPanel}>
      <div
        className={`${styles.emailPanelList}${
          emails.length === 0 ? ` ${styles.emailPanelListEmpty}` : ""
        }`}
      >
        {emails.length === 0 ? (
          <EmailEmptyState
            title="No email activity yet"
            description="Sent emails with this contact will appear here."
          />
        ) : (
          threads.map((thread) => {
            const email = thread.messages.at(-1)!;
            const threadSubject = conversationSubjectLabel(
              thread.messages[0]?.subject ?? email.subject,
            );
            const threadIdForReply =
              [...thread.messages].reverse().find((message) => message.threadId)?.threadId ??
              undefined;
            const isExpanded = expandedThreadId === thread.id;
            const messageCount = thread.messages.length;
            const latestTime = email.sentAt ?? email.receivedAt;
            const threadSummary =
              messageCount > 1
                ? `${messageCount} messages · Latest ${formatEmailTimeShort(latestTime)}`
                : `${email.direction === "outbound" ? "Sent" : "Received"} · ${formatEmailTimeShort(latestTime)}`;

            return (
              <div
                key={thread.id}
                className={`${styles.emailItem}${isExpanded ? ` ${styles.emailItemActive}` : ""}`}
              >
                <button
                  type="button"
                  className={styles.emailItemTrigger}
                  aria-expanded={isExpanded}
                  onClick={() =>
                    setExpandedThreadId((current) =>
                      current === thread.id ? null : thread.id,
                    )
                  }
                >
                  <div className={styles.emailItemInner}>
                    <span className={styles.emailThreadChevronWrap} aria-hidden="true">
                      <IconChevron open={isExpanded} />
                    </span>
                    <div className={styles.emailItemContent}>
                      <div className={styles.emailItemTop}>
                        <div className={styles.emailItemTitleRow}>
                          <p className={styles.emailItemSubject}>{threadSubject}</p>
                          {messageCount > 1 ? (
                            <span className={styles.emailThreadCountBadge}>{messageCount}</span>
                          ) : null}
                        </div>
                        <span className={styles.emailItemMeta}>
                          {formatEmailTime(latestTime)}
                        </span>
                      </div>
                      <p className={styles.emailItemMeta}>{threadSummary}</p>
                      {!isExpanded && email.snippet ? (
                        <p className={styles.emailItemPreview}>{email.snippet}</p>
                      ) : null}
                    </div>
                  </div>
                </button>

                {isExpanded ? (
                  <div className={styles.emailItemExpanded}>
                    <div className={styles.emailThreadHeader}>
                      <div className={styles.emailThreadHeaderMeta}>
                        <strong>{threadSubject}</strong>
                        <span>
                          {messageCount} message{messageCount === 1 ? "" : "s"} in this thread
                        </span>
                      </div>
                      <button
                        type="button"
                        className={styles.emailReplyButton}
                        onClick={() => {
                          openCompose(
                            {
                              contactId,
                              contactName: personName,
                              contactEmail,
                              opportunityId: opportunityId ?? undefined,
                              opportunityName: opportunityName ?? undefined,
                              threadId: threadIdForReply,
                            },
                            {
                              subject: /^re:/i.test(email.subject)
                                ? email.subject
                                : `Re: ${threadSubject}`,
                            },
                          );
                        }}
                      >
                        Reply
                      </button>
                    </div>
                    <div className={styles.emailThreadTimeline}>
                      {thread.messages.map((message, index) => {
                        const outbound = message.direction === "outbound";
                        const senderName = outbound
                          ? agentName?.trim() || "You"
                          : message.fromName?.trim() || personName;
                        const isLast = index === thread.messages.length - 1;

                        return (
                          <div
                            key={message.id}
                            className={`${styles.emailThreadTurn}${isLast ? ` ${styles.emailThreadTurnLast}` : ""}`}
                          >
                            <div className={styles.emailThreadRail} aria-hidden="true">
                              <span className={styles.emailThreadDot} />
                              {!isLast ? <span className={styles.emailThreadLine} /> : null}
                            </div>
                            <div
                              className={`${styles.emailThreadTurnRow} ${
                                outbound
                                  ? styles.emailThreadTurnOutbound
                                  : styles.emailThreadTurnInbound
                              }`}
                            >
                              {!outbound ? (
                                <EmailRowAvatar
                                  name={senderName}
                                  imageUrl={avatarUrl}
                                  tone="contact"
                                />
                              ) : null}
                              <div
                                className={`${styles.emailThreadBubble} ${
                                  outbound
                                    ? styles.emailThreadBubbleOutbound
                                    : styles.emailThreadBubbleInbound
                                }`}
                              >
                                <div className={styles.emailThreadBubbleHeader}>
                                  <strong>{senderName}</strong>
                                  <span>
                                    {formatEmailTime(message.sentAt ?? message.receivedAt)}
                                  </span>
                                </div>
                                <p className={styles.emailThreadBubbleMeta}>
                                  {outbound
                                    ? `To ${formatRecipientList(message.toRecipients)}`
                                    : `From ${message.fromEmail}`}
                                </p>
                                <div
                                  className={styles.emailDetailBody}
                                  dangerouslySetInnerHTML={{
                                    __html: message.bodyHtml || message.bodyText || "",
                                  }}
                                />
                              </div>
                              {outbound ? (
                                <EmailRowAvatar
                                  name={senderName}
                                  imageUrl={agentAvatarUrl}
                                  tone="agent"
                                />
                              ) : null}
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                ) : null}
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}
