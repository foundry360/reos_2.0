export const NOTIFICATION_CATEGORIES = [
  "tasks",
  "leads",
  "opportunities",
  "messages",
  "system",
] as const;

export type NotificationCategory = (typeof NOTIFICATION_CATEGORIES)[number];

export type NotificationPreferences = {
  tasksInApp: boolean;
  leadsInApp: boolean;
  opportunitiesInApp: boolean;
  messagesInApp: boolean;
  systemInApp: boolean;
};

export type UserNotification = {
  id: string;
  category: NotificationCategory;
  title: string;
  body: string | null;
  href: string | null;
  readAt: string | null;
  createdAt: string;
};

export const DEFAULT_NOTIFICATION_PREFERENCES: NotificationPreferences = {
  tasksInApp: true,
  leadsInApp: true,
  opportunitiesInApp: true,
  messagesInApp: true,
  systemInApp: true,
};

export const NOTIFICATION_CATEGORY_META: {
  id: NotificationCategory;
  label: string;
  description: string;
  prefKey: keyof NotificationPreferences;
}[] = [
  {
    id: "tasks",
    label: "Tasks",
    description: "Due dates, assignments, and completed follow-ups.",
    prefKey: "tasksInApp",
  },
  {
    id: "leads",
    label: "Leads",
    description: "New leads and ownership changes.",
    prefKey: "leadsInApp",
  },
  {
    id: "opportunities",
    label: "Opportunities",
    description: "Stage changes and deal updates.",
    prefKey: "opportunitiesInApp",
  },
  {
    id: "messages",
    label: "Messaging",
    description: "Inbound SMS and email replies.",
    prefKey: "messagesInApp",
  },
  {
    id: "system",
    label: "Product updates",
    description: "REOS product announcements and account notices.",
    prefKey: "systemInApp",
  },
];
