import { createHmac, timingSafeEqual } from "crypto";

const INVITE_TTL_SECONDS = 60 * 60 * 24 * 7; // 7 days

function signingSecret(): string {
  const secret =
    process.env.SUPABASE_SERVICE_ROLE_KEY?.trim() ||
    process.env.PLATFORM_SECRETS_ENCRYPTION_KEY?.trim();
  if (!secret) {
    throw new Error("Missing signing secret for invite links.");
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

function fromB64url(input: string): Buffer {
  const padded = input.replace(/-/g, "+").replace(/_/g, "/");
  const pad = padded.length % 4 === 0 ? "" : "=".repeat(4 - (padded.length % 4));
  return Buffer.from(padded + pad, "base64");
}

export function signTenantInviteToken(email: string): string {
  const payload = {
    email: email.trim().toLowerCase(),
    exp: Math.floor(Date.now() / 1000) + INVITE_TTL_SECONDS,
  };
  const body = b64url(JSON.stringify(payload));
  const sig = b64url(createHmac("sha256", signingSecret()).update(body).digest());
  return `${body}.${sig}`;
}

export function verifyTenantInviteToken(
  token: string,
): { ok: true; email: string } | { ok: false; error: string } {
  const [body, sig] = token.split(".");
  if (!body || !sig) return { ok: false, error: "Malformed invite token." };

  const expected = b64url(createHmac("sha256", signingSecret()).update(body).digest());
  const sigBuf = Buffer.from(sig);
  const expectedBuf = Buffer.from(expected);
  if (sigBuf.length !== expectedBuf.length || !timingSafeEqual(sigBuf, expectedBuf)) {
    return { ok: false, error: "Invalid invite token." };
  }

  try {
    const payload = JSON.parse(fromB64url(body).toString("utf8")) as {
      email?: string;
      exp?: number;
    };
    if (!payload.email || typeof payload.exp !== "number") {
      return { ok: false, error: "Invalid invite payload." };
    }
    if (payload.exp < Math.floor(Date.now() / 1000)) {
      return { ok: false, error: "Invite link has expired." };
    }
    return { ok: true, email: payload.email.trim().toLowerCase() };
  } catch {
    return { ok: false, error: "Invalid invite payload." };
  }
}

export function buildAcceptInviteUrl(origin: string, email: string): string {
  const token = signTenantInviteToken(email);
  return `${origin}/auth/accept-invite?token=${encodeURIComponent(token)}`;
}
