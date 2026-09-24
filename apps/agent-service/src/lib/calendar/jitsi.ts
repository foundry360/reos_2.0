import { randomBytes } from "node:crypto";

function sanitizeRoomSegment(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
}

/** Unique room name for a scheduled public Jitsi meeting. */
export function createMeetingRoomName(seed?: string | null): string {
  const random = randomBytes(4).toString("hex");
  const seedPart = seed ? sanitizeRoomSegment(seed) : "";
  return seedPart
    ? `reos-${seedPart}-${random}`
    : `reos-${random}${randomBytes(2).toString("hex")}`;
}

/** Public Meet always works; optional JITSI_BASE_URL overrides meet.jit.si. */
export function isVideoConferencingConfigured(): boolean {
  return true;
}

export function getJitsiBaseUrl(): string {
  return (process.env.JITSI_BASE_URL?.trim() || "https://meet.jit.si").replace(/\/+$/, "");
}

export function buildJitsiMeetingUrl(room: string): string {
  const safeRoom = room.replace(/^\/+|\/+$/g, "");
  return `${getJitsiBaseUrl()}/${encodeURIComponent(safeRoom)}`;
}

export function createJitsiMeetingUrl(seed?: string | null): {
  room: string;
  url: string;
} {
  const room = createMeetingRoomName(seed);
  return { room, url: buildJitsiMeetingUrl(room) };
}
