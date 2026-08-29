function startOfLocalDay(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

/** Week starts on Sunday (en-US). */
function startOfLocalWeek(date: Date): Date {
  const start = startOfLocalDay(date);
  start.setDate(start.getDate() - start.getDay());
  return start;
}

function startOfLocalMonth(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), 1);
}

export function activityGroupForDate(
  iso: string,
  now = new Date(),
): { key: string; label: string; sort: number } {
  const date = startOfLocalDay(new Date(iso));
  const today = startOfLocalDay(now);
  if (Number.isNaN(date.getTime())) {
    return { key: "today", label: "Today", sort: 0 };
  }
  if (date.getTime() > today.getTime()) {
    return { key: "upcoming", label: "Upcoming", sort: -1 };
  }

  const yesterday = new Date(today);
  yesterday.setDate(yesterday.getDate() - 1);
  const thisWeekStart = startOfLocalWeek(today);
  const lastWeekStart = new Date(thisWeekStart);
  lastWeekStart.setDate(lastWeekStart.getDate() - 7);
  const thisMonthStart = startOfLocalMonth(today);

  if (date.getTime() === today.getTime()) {
    return { key: "today", label: "Today", sort: 0 };
  }
  if (date.getTime() === yesterday.getTime()) {
    return { key: "yesterday", label: "Yesterday", sort: 1 };
  }
  if (date >= thisWeekStart) {
    return { key: "this-week", label: "This Week", sort: 2 };
  }
  if (date >= lastWeekStart) {
    return { key: "last-week", label: "Last Week", sort: 3 };
  }
  if (date >= thisMonthStart) {
    return { key: "this-month", label: "This Month", sort: 4 };
  }

  const monthStart = startOfLocalMonth(date);
  return {
    key: `month-${monthStart.getFullYear()}-${monthStart.getMonth()}`,
    label: new Intl.DateTimeFormat("en-US", {
      month: "long",
      year: "numeric",
    }).format(monthStart),
    sort: 1000 - (monthStart.getFullYear() * 12 + monthStart.getMonth()),
  };
}

export function groupByActivityDate<T>(
  items: T[],
  getIso: (item: T) => string,
): { key: string; label: string; items: T[] }[] {
  const groups = new Map<string, { key: string; label: string; sort: number; items: T[] }>();

  for (const item of items) {
    const meta = activityGroupForDate(getIso(item));
    const existing = groups.get(meta.key);
    if (existing) {
      existing.items.push(item);
    } else {
      groups.set(meta.key, { ...meta, items: [item] });
    }
  }

  return [...groups.values()]
    .sort((a, b) => a.sort - b.sort)
    .map(({ key, label, items: groupItems }) => {
      const sorted =
        key === "upcoming"
          ? [...groupItems].sort(
              (a, b) => new Date(getIso(a)).getTime() - new Date(getIso(b)).getTime(),
            )
          : groupItems;
      return { key, label, items: sorted };
    });
}
