import { getEnv } from "@/lib/env";

const META_GRAPH_VERSION = "v21.0";

export interface MetaPageOption {
  id: string;
  name: string;
  accessToken: string;
  instagramBusinessAccountId: string | null;
  instagramUsername: string | null;
  /** True when Page can use Instagram Messaging (even if Graph omits business account fields). */
  instagramMessagingEligible: boolean;
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

/**
 * Graph often omits `instagram_business_account` even when Page Settings show a linked
 * professional IG. Conversations with platform=instagram succeeds only when messaging is linked.
 */
async function pageSupportsInstagramMessaging(
  pageId: string,
  pageAccessToken: string,
): Promise<boolean> {
  const params = new URLSearchParams({
    platform: "instagram",
    fields: "id",
    limit: "1",
    access_token: pageAccessToken,
  });

  const response = await fetch(
    `https://graph.facebook.com/${META_GRAPH_VERSION}/${encodeURIComponent(pageId)}/conversations?${params.toString()}`,
  );

  if (response.ok) return true;

  const body = await response.text();
  // 2534013 = page not linked to a professional Instagram account
  if (body.includes("2534013") || body.toLowerCase().includes("not linked")) {
    return false;
  }

  // Other errors (rate limit, transient) — do not treat as eligible
  return false;
}

async function enrichInstagramEligibility(pages: MetaPageOption[]): Promise<MetaPageOption[]> {
  return Promise.all(
    pages.map(async (page) => {
      if (page.instagramBusinessAccountId) {
        return { ...page, instagramMessagingEligible: true };
      }

      const eligible = await pageSupportsInstagramMessaging(page.id, page.accessToken);
      return { ...page, instagramMessagingEligible: eligible };
    }),
  );
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

  const mapped = pages
    .map((page) => {
      const id = page.id?.trim() ?? "";
      const name = page.name?.trim() ?? "";
      const accessToken = page.access_token?.trim() ?? "";
      if (!id || !name || !accessToken) return null;

      const ig = page.instagram_business_account;
      const instagramBusinessAccountId = ig?.id?.trim() || null;
      return {
        id,
        name,
        accessToken,
        instagramBusinessAccountId,
        instagramUsername: ig?.username?.trim() || null,
        instagramMessagingEligible: Boolean(instagramBusinessAccountId),
      } satisfies MetaPageOption;
    })
    .filter((page): page is MetaPageOption => page !== null);

  return enrichInstagramEligibility(mapped);
}

export function filterMetaPagesForChannel(
  pages: MetaPageOption[],
  channel: "messenger" | "instagram",
): MetaPageOption[] {
  if (channel === "instagram") {
    return pages.filter(
      (page) => page.instagramMessagingEligible || Boolean(page.instagramBusinessAccountId),
    );
  }
  return pages;
}
