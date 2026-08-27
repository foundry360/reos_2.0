import { getEnv } from "@/lib/env";

export type GoogleChannel = "email" | "calendar";

export interface GoogleOAuthState {
  tenantId: string;
  channel: GoogleChannel;
}

const GOOGLE_SCOPES: Record<GoogleChannel, string[]> = {
  email: [
    "https://www.googleapis.com/auth/gmail.readonly",
    "https://www.googleapis.com/auth/gmail.send",
    "https://www.googleapis.com/auth/userinfo.email",
  ],
  calendar: [
    "https://www.googleapis.com/auth/calendar",
    "https://www.googleapis.com/auth/userinfo.email",
  ],
};

export function isGoogleOAuthConfigured(): boolean {
  const env = getEnv();
  return Boolean(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET);
}

export function encodeGoogleOAuthState(state: GoogleOAuthState): string {
  return Buffer.from(JSON.stringify(state)).toString("base64url");
}

export function decodeGoogleOAuthState(raw: string): GoogleOAuthState | null {
  try {
    const parsed = JSON.parse(Buffer.from(raw, "base64url").toString("utf8")) as GoogleOAuthState;
    if (parsed?.tenantId && (parsed.channel === "email" || parsed.channel === "calendar")) {
      return parsed;
    }
    return null;
  } catch {
    return null;
  }
}

export function buildGoogleOAuthUrl(state: GoogleOAuthState, redirectUri: string): string {
  const env = getEnv();
  if (!env.GOOGLE_CLIENT_ID) {
    throw new Error("Google OAuth is not configured.");
  }

  const params = new URLSearchParams({
    client_id: env.GOOGLE_CLIENT_ID,
    redirect_uri: redirectUri,
    response_type: "code",
    scope: GOOGLE_SCOPES[state.channel].join(" "),
    access_type: "offline",
    prompt: "consent",
    state: encodeGoogleOAuthState(state),
  });

  return `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`;
}

export interface GoogleTokenResponse {
  accessToken: string;
  refreshToken: string | null;
  expiresIn: number | null;
  scope: string | null;
  tokenType: string | null;
}

export async function exchangeGoogleOAuthCode(
  code: string,
  redirectUri: string,
): Promise<GoogleTokenResponse> {
  const env = getEnv();
  if (!env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET) {
    throw new Error("Google OAuth is not configured.");
  }

  const response = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: env.GOOGLE_CLIENT_ID,
      client_secret: env.GOOGLE_CLIENT_SECRET,
      redirect_uri: redirectUri,
      grant_type: "authorization_code",
    }),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(body || "Google token exchange failed.");
  }

  const data = (await response.json()) as {
    access_token?: string;
    refresh_token?: string;
    expires_in?: number;
    scope?: string;
    token_type?: string;
  };

  if (!data.access_token) {
    throw new Error("Google token exchange returned no access token.");
  }

  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token ?? null,
    expiresIn: data.expires_in ?? null,
    scope: data.scope ?? null,
    tokenType: data.token_type ?? null,
  };
}

export async function fetchGoogleAccountEmail(accessToken: string): Promise<string | null> {
  const response = await fetch("https://www.googleapis.com/oauth2/v2/userinfo", {
    headers: { Authorization: `Bearer ${accessToken}` },
  });

  if (!response.ok) return null;

  const data = (await response.json()) as { email?: string };
  return data.email?.trim() || null;
}
