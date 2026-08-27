import { getEnv } from "@/lib/env";

export type MetaChannel = "messenger" | "instagram";

const META_OAUTH_VERSION = "v21.0";

export interface MetaOAuthState {
  tenantId: string;
  channel: MetaChannel;
}

export function isMetaOAuthConfigured(): boolean {
  const env = getEnv();
  return Boolean(env.META_APP_ID && env.META_APP_SECRET);
}

export function encodeMetaOAuthState(state: MetaOAuthState): string {
  return Buffer.from(JSON.stringify(state)).toString("base64url");
}

export function decodeMetaOAuthState(raw: string): MetaOAuthState | null {
  try {
    const parsed = JSON.parse(Buffer.from(raw, "base64url").toString("utf8")) as MetaOAuthState;
    if (
      parsed?.tenantId &&
      (parsed.channel === "messenger" || parsed.channel === "instagram")
    ) {
      return parsed;
    }
    return null;
  } catch {
    return null;
  }
}

export function buildMetaOAuthUrl(state: MetaOAuthState, redirectUri: string): string {
  const env = getEnv();
  if (!env.META_APP_ID) {
    throw new Error("Meta OAuth is not configured.");
  }

  const scopes = [
    "pages_show_list",
    "pages_messaging",
    "pages_manage_metadata",
    "instagram_basic",
    "instagram_manage_messages",
  ];

  const params = new URLSearchParams({
    client_id: env.META_APP_ID,
    redirect_uri: redirectUri,
    state: encodeMetaOAuthState(state),
    scope: scopes.join(","),
    response_type: "code",
  });

  return `https://www.facebook.com/${META_OAUTH_VERSION}/dialog/oauth?${params.toString()}`;
}

export async function exchangeMetaOAuthCode(
  code: string,
  redirectUri: string,
): Promise<{ accessToken: string; expiresIn: number | null }> {
  const env = getEnv();
  if (!env.META_APP_ID || !env.META_APP_SECRET) {
    throw new Error("Meta OAuth is not configured.");
  }

  const params = new URLSearchParams({
    client_id: env.META_APP_ID,
    client_secret: env.META_APP_SECRET,
    redirect_uri: redirectUri,
    code,
  });

  const response = await fetch(
    `https://graph.facebook.com/${META_OAUTH_VERSION}/oauth/access_token?${params.toString()}`,
  );

  if (!response.ok) {
    const body = await response.text();
    throw new Error(body || "Meta token exchange failed.");
  }

  const data = (await response.json()) as { access_token?: string; expires_in?: number };
  if (!data.access_token) {
    throw new Error("Meta token exchange returned no access token.");
  }

  return {
    accessToken: data.access_token,
    expiresIn: data.expires_in ?? null,
  };
}
