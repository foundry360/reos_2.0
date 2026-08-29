"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState, useTransition } from "react";
import { formatRelativeTime } from "@/lib/admin/activity-timeline";
import {
  markAllNotificationsReadAction,
  markNotificationReadAction,
} from "@/lib/notifications/actions";
import type { UserNotification } from "@/lib/notifications/types";
import { NOTIFICATION_CATEGORY_META } from "@/lib/notifications/types";
import styles from "./shell.module.css";

function IconBell() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path
        d="M6 9a6 6 0 0 1 12 0c0 7 3 7 3 7H3s3 0 3-7"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M10 19a2 2 0 0 0 4 0"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function categoryLabel(category: UserNotification["category"]): string {
  return (
    NOTIFICATION_CATEGORY_META.find((item) => item.id === category)?.label ?? category
  );
}

export function NotificationsMenu({
  initialNotifications,
}: {
  initialNotifications: UserNotification[];
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState(initialNotifications);
  const [pending, startTransition] = useTransition();
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setItems(initialNotifications);
  }, [initialNotifications]);

  useEffect(() => {
    function onDocClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener("mousedown", onDocClick);
    return () => document.removeEventListener("mousedown", onDocClick);
  }, []);

  const unreadCount = items.filter((item) => !item.readAt).length;

  function markRead(id: string) {
    setItems((current) =>
      current.map((item) =>
        item.id === id ? { ...item, readAt: item.readAt ?? new Date().toISOString() } : item,
      ),
    );
    startTransition(async () => {
      await markNotificationReadAction(id);
      router.refresh();
    });
  }

  function markAllRead() {
    if (unreadCount === 0) return;
    const now = new Date().toISOString();
    setItems((current) =>
      current.map((item) => ({ ...item, readAt: item.readAt ?? now })),
    );
    startTransition(async () => {
      await markAllNotificationsReadAction();
      router.refresh();
    });
  }

  return (
    <div className={styles.notificationsMenu} ref={ref}>
      <button
        type="button"
        className={`${styles.headerIconBtn} ${open ? styles.headerIconBtnActive : ""}`}
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        aria-haspopup="menu"
        aria-label={
          unreadCount > 0
            ? `Notifications, ${unreadCount} unread`
            : "Notifications"
        }
      >
        <IconBell />
        {unreadCount > 0 ? (
          <span className={styles.notificationsBadge}>
            {unreadCount > 99 ? "99+" : unreadCount}
          </span>
        ) : null}
      </button>

      {open ? (
        <div className={styles.notificationsDropdown} role="menu">
          <div className={styles.notificationsHeader}>
            <div>
              <p className={styles.notificationsTitle}>Notifications</p>
              <p className={styles.notificationsSubtitle}>
                {unreadCount > 0
                  ? `${unreadCount} unread`
                  : "You're all caught up"}
              </p>
            </div>
            {items.length > 0 ? (
              <div className={styles.notificationsHeaderActions}>
                <button
                  type="button"
                  className={styles.notificationsTextBtn}
                  onClick={markAllRead}
                  disabled={pending || unreadCount === 0}
                >
                  Mark all as read
                </button>
              </div>
            ) : null}
          </div>

          {items.length === 0 ? (
            <div className={styles.notificationsEmpty}>
              <p className={styles.notificationsEmptyTitle}>No notifications yet</p>
              <p className={styles.notificationsEmptyText}>
                Task reminders, lead updates, and deal changes will show up here.
              </p>
            </div>
          ) : (
            <>
              <ul className={styles.notificationsList}>
                {items.map((item) => {
                  const unread = !item.readAt;
                  const content = (
                    <>
                      <span className={styles.notificationsItemTop}>
                        <span className={styles.notificationsItemCategory}>
                          {categoryLabel(item.category)}
                        </span>
                        <time
                          className={styles.notificationsItemTime}
                          dateTime={item.createdAt}
                        >
                          {formatRelativeTime(item.createdAt)}
                        </time>
                      </span>
                      <span className={styles.notificationsItemTitle}>{item.title}</span>
                      {item.body ? (
                        <span className={styles.notificationsItemBody}>{item.body}</span>
                      ) : null}
                    </>
                  );

                  return (
                    <li key={item.id}>
                      {item.href ? (
                        <Link
                          href={item.href}
                          className={`${styles.notificationsItem} ${
                            unread ? styles.notificationsItemUnread : ""
                          }`}
                          role="menuitem"
                          onClick={() => {
                            if (unread) markRead(item.id);
                            setOpen(false);
                          }}
                        >
                          {content}
                        </Link>
                      ) : (
                        <button
                          type="button"
                          className={`${styles.notificationsItem} ${
                            unread ? styles.notificationsItemUnread : ""
                          }`}
                          role="menuitem"
                          onClick={() => {
                            if (unread) markRead(item.id);
                          }}
                        >
                          {content}
                        </button>
                      )}
                    </li>
                  );
                })}
              </ul>
              {unreadCount > 0 ? (
                <div className={styles.notificationsFooter}>
                  <button
                    type="button"
                    className={`${styles.btnSecondary} ${styles.btnPill}`}
                    onClick={markAllRead}
                    disabled={pending}
                  >
                    Mark all as read
                  </button>
                </div>
              ) : null}
            </>
          )}
        </div>
      ) : null}
    </div>
  );
}
