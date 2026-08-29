import { getEnv } from "@/lib/env";

const META_GRAPH_VERSION = "v21.0";

export interface MetaPageOption {
  id: string;
  name: string;
  accessToken: string;
  instagramBusinessAccountId: string | null;
  instagramUsername: string | null;
}

interface GraphPageNode {
  id?: string;
  name?: string;
  access_token?: string;
  instagram_business_account?: {
    id?: string;
    username?: string;
  } | null;
}

/** Exchange a short-lived user token for a long-lived one (~60 days). */
export async function exchangeMetaLongLivedUserToken(
  shortLivedToken: string,
): Promise<{ accessToken: string; expiresIn: number | null }> {
  const env = getEnv();
  if (!env.META_APP_ID || !env.META_APP_SECRET) {
    throw new Error("Meta OAuth is not configured.");
  }

  const params = new URLSearchParams({
    grant_type: "fb_exchange_token",
    client_id: env.META_APP_ID,
    client_secret: env.META_APP_SECRET,
    fb_exchange_token: shortLivedToken,
  });

  const response = await fetch(
    `https://graph.facebook.com/${META_GRAPH_VERSION}/oauth/access_token?${params.toString()}`,
  );

  if (!response.ok) {
    const body = await response.text();
    throw new Error(body || "Meta long-lived token exchange failed.");
  }

  const data = (await response.json()) as { access_token?: string; expires_in?: number };
  if (!data.access_token) {
    throw new Error("Meta long-lived token exchange returned no access token.");
  }

  return {
    accessToken: data.access_token,
    expiresIn: data.expires_in ?? null,
  };
}

export async function fetchMetaPages(userAccessToken: string): Promise<MetaPageOption[]> {
  const params = new URLSearchParams({
    fields: "id,name,access_token,instagram_business_account{id,username}",
    access_token: userAccessToken,
    limit: "100",
  });

  const response = await fetch(
    `https://graph.facebook.com/${META_GRAPH_VERSION}/me/accounts?${params.toString()}`,
  );

  if (!response.ok) {
    const body = await response.text();
    throw new Error(body || "Could not load Facebook Pages.");
  }

  const data = (await response.json()) as { data?: GraphPageNode[] };
  const pages = Array.isArray(data.data) ? data.data : [];

  return pages
    .map((page) => {
      const id = page.id?.trim() ?? "";
      const name = page.name?.trim() ?? "";
      const accessToken = page.access_token?.trim() ?? "";
      if (!id || !name || !accessToken) return null;

      const ig = page.instagram_business_account;
      return {
        id,
        name,
        accessToken,
        instagramBusinessAccountId: ig?.id?.trim() || null,
        instagramUsername: ig?.username?.trim() || null,
      } satisfies MetaPageOption;
    })
    .filter((page): page is MetaPageOption => page !== null);
}

export function filterMetaPagesForChannel(
  pages: MetaPageOption[],
  channel: "messenger" | "instagram",
): MetaPageOption[] {
  if (channel === "instagram") {
    return pages.filter((page) => Boolean(page.instagramBusinessAccountId));
  }
  return pages;
}
