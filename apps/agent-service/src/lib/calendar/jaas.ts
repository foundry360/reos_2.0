import { SignJWT, importPKCS8 } from "jose";
import { getEnv } from "@/lib/env";

export interface JaasParticipant {
  id: string;
  name?: string | null;
  email?: string | null;
  moderator: boolean;
}

function normalizePrivateKeyPem(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed.includes("-----BEGIN")) {
    return trimmed.replace(/\\n/g, "\n");
  }
  // Raw base64 body without headers
  const body = trimmed.replace(/\s+/g, "");
  return `-----BEGIN PRIVATE KEY-----\n${body}\n-----END PRIVATE KEY-----`;
}

export function isJaasConfigured(): boolean {
  const env = getEnv();
  return Boolean(
    env.JAAS_APP_ID?.trim() &&
      env.JAAS_API_KEY_ID?.trim() &&
      env.JAAS_PRIVATE_KEY?.trim(),
  );
}

export function getJaasAppId(): string {
  const id = getEnv().JAAS_APP_ID?.trim();
  if (!id) throw new Error("JAAS_APP_ID is not configured.");
  return id;
}

/** Meeting opens at https://8x8.vc/{appId}/{room} */
export function buildJaasRoomUrl(room: string): string {
  const appId = getJaasAppId();
  const safeRoom = room.replace(/^\/+|\/+$/g, "");
  return `https://8x8.vc/${appId}/${encodeURIComponent(safeRoom)}`;
}

/**
 * Mint a short-lived JaaS JWT for one participant.
 * Prefer REOS join redirects so tokens are fresh when the meeting starts.
 */
export async function mintJaasJwt(params: {
  room: string;
  participant: JaasParticipant;
  /** Token lifetime in seconds (default 3 hours). */
  ttlSeconds?: number;
}): Promise<string> {
  const env = getEnv();
  const appId = env.JAAS_APP_ID?.trim();
  const keyId = env.JAAS_API_KEY_ID?.trim();
  const privateKeyPem = env.JAAS_PRIVATE_KEY?.trim();
  if (!appId || !keyId || !privateKeyPem) {
    throw new Error("JaaS is not configured (JAAS_APP_ID / JAAS_API_KEY_ID / JAAS_PRIVATE_KEY).");
  }

  const ttl = params.ttlSeconds ?? 60 * 60 * 3;
  const now = Math.floor(Date.now() / 1000);
  const key = await importPKCS8(normalizePrivateKeyPem(privateKeyPem), "RS256");

  return new SignJWT({
    aud: "jitsi",
    iss: "chat",
    sub: appId,
    room: params.room,
    context: {
      user: {
        id: params.participant.id,
        name: params.participant.name?.trim() || "Guest",
        email: params.participant.email?.trim() || undefined,
        moderator: params.participant.moderator ? "true" : "false",
      },
      features: {
        recording: "false",
        livestreaming: "false",
        transcription: "false",
        "outbound-call": "false",
      },
    },
  })
    .setProtectedHeader({ alg: "RS256", kid: keyId, typ: "JWT" })
    .setIssuedAt(now)
    .setNotBefore(now - 10)
    .setExpirationTime(now + ttl)
    .sign(key);
}

export async function buildJaasJoinUrl(params: {
  room: string;
  participant: JaasParticipant;
  ttlSeconds?: number;
}): Promise<string> {
  const jwt = await mintJaasJwt(params);
  return `${buildJaasRoomUrl(params.room)}?jwt=${encodeURIComponent(jwt)}`;
}
