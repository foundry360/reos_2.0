export function formatAuditTimestamp(timestamp: string, timezone: string): string {
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZone: timezone,
  }).format(new Date(timestamp));
}

export function formatAuditDisplay(
  userLabel: string | null | undefined,
  timestamp: string | null | undefined,
  timezone: string,
): string {
  const name = userLabel?.trim();
  const formattedDate = timestamp ? formatAuditTimestamp(timestamp, timezone) : null;

  if (name && formattedDate) return `${name} · ${formattedDate}`;
  if (name) return name;
  if (formattedDate) return formattedDate;
  return "—";
}
