import { randomBytes } from "node:crypto";

function sanitizeRoomSegment(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
}

/**
 * Unique room name for a scheduled meeting (JaaS or legacy Meet).
 */
export function createMeetingRoomName(seed?: string | null): string {
  const random = randomBytes(4).toString("hex");
  const seedPart = seed ? sanitizeRoomSegment(seed) : "";
  return seedPart
    ? `reos-${seedPart}-${random}`
    : `reos-${random}${randomBytes(2).toString("hex")}`;
}

export function isVideoConferencingConfigured(): boolean {
  return Boolean(
    process.env.JAAS_APP_ID?.trim() &&
      process.env.JAAS_API_KEY_ID?.trim() &&
      process.env.JAAS_PRIVATE_KEY?.trim(),
  );
}

/** @deprecated Use createMeetingRoomName + JaaS join redirects. */
export function createJitsiMeetingUrl(seed?: string | null): {
  room: string;
  url: string;
} {
  const room = createMeetingRoomName(seed);
  const base = (process.env.JITSI_BASE_URL?.trim() || "https://meet.jit.si").replace(
    /\/+$/,
    "",
  );
  return { room, url: `${base}/${room}` };
}

export function getJitsiBaseUrl(): string {
  return (process.env.JITSI_BASE_URL?.trim() || "https://meet.jit.si").replace(/\/+$/, "");
}
