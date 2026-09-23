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
  // Keep older months after "This Month" (sort 4), newest month first.
  const monthIndex = monthStart.getFullYear() * 12 + monthStart.getMonth();
  return {
    key: `month-${monthStart.getFullYear()}-${monthStart.getMonth()}`,
    label: new Intl.DateTimeFormat("en-US", {
      month: "long",
      year: "numeric",
    }).format(monthStart),
    sort: 5 + (2100 * 12 - monthIndex),
  };
}

export function groupByActivityDate<T>(
  items: T[],
  getIso: (item: T) => string,
  now = new Date(),
): { key: string; label: string; items: T[] }[] {
  const groups = new Map<string, { key: string; label: string; sort: number; items: T[] }>();

  for (const item of items) {
    const meta = activityGroupForDate(getIso(item), now);
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
      const sorted = [...groupItems].sort((a, b) => {
        const aTime = new Date(getIso(a)).getTime();
        const bTime = new Date(getIso(b)).getTime();
        // Upcoming: soonest first. Past groups: most recent first.
        return key === "upcoming" ? aTime - bTime : bTime - aTime;
      });
      return { key, label, items: sorted };
    });
}
