/** Build a METHOD:REQUEST .ics calendar invite (RFC 5545 subset). */

export interface IcsAttendee {
  email: string;
  name?: string | null;
}

export interface BuildIcsInviteParams {
  uid: string;
  summary: string;
  description?: string | null;
  location?: string | null;
  start: Date;
  end: Date;
  organizer: IcsAttendee;
  attendees: IcsAttendee[];
  timeZone?: string | null;
}

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

/** UTC stamp for DTSTAMP / floating absolute times (Zulu). */
export function formatIcsUtc(date: Date): string {
  return (
    `${date.getUTCFullYear()}${pad(date.getUTCMonth() + 1)}${pad(date.getUTCDate())}` +
    `T${pad(date.getUTCHours())}${pad(date.getUTCMinutes())}${pad(date.getUTCSeconds())}Z`
  );
}

function escapeIcsText(value: string): string {
  return value
    .replace(/\\/g, "\\\\")
    .replace(/\n/g, "\\n")
    .replace(/,/g, "\\,")
    .replace(/;/g, "\\;");
}

function foldLine(line: string): string {
  if (line.length <= 75) return line;
  const parts: string[] = [];
  let remaining = line;
  parts.push(remaining.slice(0, 75));
  remaining = remaining.slice(75);
  while (remaining.length > 0) {
    parts.push(` ${remaining.slice(0, 74)}`);
    remaining = remaining.slice(74);
  }
  return parts.join("\r\n");
}

function attendeeLine(kind: "ORGANIZER" | "ATTENDEE", person: IcsAttendee): string {
  const email = person.email.trim().toLowerCase();
  const cn = person.name?.replace(/[\r\n";]/g, " ").trim();
  if (kind === "ORGANIZER") {
    return cn
      ? `ORGANIZER;CN=${cn}:mailto:${email}`
      : `ORGANIZER:mailto:${email}`;
  }
  return cn
    ? `ATTENDEE;CN=${cn};RSVP=TRUE;ROLE=REQ-PARTICIPANT:mailto:${email}`
    : `ATTENDEE;RSVP=TRUE;ROLE=REQ-PARTICIPANT:mailto:${email}`;
}

export function buildIcsInvite(params: BuildIcsInviteParams): string {
  const summary = escapeIcsText(params.summary.trim() || "Meeting");
  const description = params.description?.trim()
    ? escapeIcsText(params.description.trim())
    : null;
  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//REOS//Calendar//EN",
    "CALSCALE:GREGORIAN",
    "METHOD:REQUEST",
    "BEGIN:VEVENT",
    `UID:${params.uid.replace(/[\r\n]/g, "")}`,
    `DTSTAMP:${formatIcsUtc(new Date())}`,
    `DTSTART:${formatIcsUtc(params.start)}`,
    `DTEND:${formatIcsUtc(params.end)}`,
    `SUMMARY:${summary}`,
  ];
  if (description) lines.push(`DESCRIPTION:${description}`);
  const location = params.location?.trim();
  if (location) lines.push(`LOCATION:${escapeIcsText(location)}`);
  lines.push(attendeeLine("ORGANIZER", params.organizer));
  for (const attendee of params.attendees) {
    lines.push(attendeeLine("ATTENDEE", attendee));
  }
  lines.push("STATUS:CONFIRMED", "SEQUENCE:0", "END:VEVENT", "END:VCALENDAR");
  return `${lines.map(foldLine).join("\r\n")}\r\n`;
}
