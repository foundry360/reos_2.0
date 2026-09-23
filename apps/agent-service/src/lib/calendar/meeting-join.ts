import { createHmac, timingSafeEqual } from "node:crypto";

export type MeetingJoinRole = "host" | "guest";

export interface MeetingJoinPayload {
  activityId: string;
  tenantId: string;
  role: MeetingJoinRole;
  /** Unix seconds */
  exp: number;
}

function joinSecret(): string {
  const secret =
    process.env.MEETING_JOIN_SECRET?.trim() ||
    process.env.PLATFORM_SECRETS_ENCRYPTION_KEY?.trim() ||
    process.env.SUPABASE_SERVICE_ROLE_KEY?.trim() ||
    "";
  if (!secret) {
    throw new Error("No secret available to sign meeting join links.");
  }
  return secret;
}

function b64url(input: Buffer | string): string {
  const buf = typeof input === "string" ? Buffer.from(input, "utf8") : input;
  return buf
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

function fromB64url(value: string): Buffer {
  const padded = value.replace(/-/g, "+").replace(/_/g, "/");
  const pad = padded.length % 4 === 0 ? "" : "=".repeat(4 - (padded.length % 4));
  return Buffer.from(padded + pad, "base64");
}

export function signMeetingJoinToken(payload: MeetingJoinPayload): string {
  const body = b64url(JSON.stringify(payload));
  const sig = createHmac("sha256", joinSecret()).update(body).digest();
  return `${body}.${b64url(sig)}`;
}

export function verifyMeetingJoinToken(token: string): MeetingJoinPayload | null {
  const [body, sig] = token.split(".");
  if (!body || !sig) return null;
  try {
    const expected = createHmac("sha256", joinSecret()).update(body).digest();
    const actual = fromB64url(sig);
    if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
      return null;
    }
    const payload = JSON.parse(fromB64url(body).toString("utf8")) as MeetingJoinPayload;
    if (!payload?.activityId || !payload.tenantId) return null;
    if (payload.role !== "host" && payload.role !== "guest") return null;
    if (!payload.exp || payload.exp * 1000 < Date.now()) return null;
    return payload;
  } catch {
    return null;
  }
}

export function getPublicSiteUrl(): string {
  return (
    process.env.NEXT_PUBLIC_SITE_URL?.trim().replace(/\/$/, "") ||
    "http://localhost:3000"
  );
}

/**
 * Stable REOS join link. Mints a fresh JaaS JWT when opened (so invites stay valid).
 */
export function buildMeetingJoinUrl(params: {
  activityId: string;
  tenantId: string;
  role: MeetingJoinRole;
  /** Meeting end time; token valid until end + 7 days (min 7 days from now). */
  endsAt: Date;
}): string {
  const minExp = Math.floor(Date.now() / 1000) + 60 * 60 * 24 * 7;
  const endExp = Math.floor(params.endsAt.getTime() / 1000) + 60 * 60 * 24 * 7;
  const token = signMeetingJoinToken({
    activityId: params.activityId,
    tenantId: params.tenantId,
    role: params.role,
    exp: Math.max(minExp, endExp),
  });
  return `${getPublicSiteUrl()}/api/meetings/join?token=${encodeURIComponent(token)}`;
}
