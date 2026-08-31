const META_GRAPH_VERSION = "v21.0";

export interface MetaSenderProfile {
  firstName: string | null;
  lastName: string | null;
  avatarUrl: string | null;
}

function splitDisplayName(name: string): { firstName: string | null; lastName: string | null } {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return { firstName: null, lastName: null };
  if (parts.length === 1) return { firstName: parts[0], lastName: null };
  return { firstName: parts[0], lastName: parts.slice(1).join(" ") };
}

/** Messenger / IG sender profile via Page token (PSID / IGSID). */
export async function fetchMetaSenderProfile(
  senderId: string,
  pageAccessToken: string,
  channel: "messenger" | "instagram" = "messenger",
): Promise<MetaSenderProfile | null> {
  // Instagram User nodes do not support first_name/last_name/profile_pic — requesting
  // those fields fails the whole call and we end up with "Unknown" leads.
  const fields =
    channel === "instagram"
      ? "name,username"
      : "first_name,last_name,name,profile_pic";

  const params = new URLSearchParams({
    fields,
    access_token: pageAccessToken,
  });

  const response = await fetch(
    `https://graph.facebook.com/${META_GRAPH_VERSION}/${encodeURIComponent(senderId)}?${params.toString()}`,
  );

  if (!response.ok) {
    const body = await response.text();
    console.warn("Meta sender profile failed:", response.status, body);
    return null;
  }

  const data = (await response.json()) as {
    first_name?: string;
    last_name?: string;
    name?: string;
    username?: string;
    profile_pic?: string;
  };

  let firstName = data.first_name?.trim() || null;
  let lastName = data.last_name?.trim() || null;

  if (!firstName && !lastName) {
    if (data.name?.trim()) {
      const split = splitDisplayName(data.name);
      firstName = split.firstName;
      lastName = split.lastName;
    } else if (data.username?.trim()) {
      firstName = `@${data.username.trim().replace(/^@/, "")}`;
    }
  }

  let avatarUrl = data.profile_pic?.trim() || null;
  if (!avatarUrl) {
    avatarUrl = await fetchMetaSenderPictureUrl(senderId, pageAccessToken);
  }

  if (!firstName && !lastName && !avatarUrl) return null;
  return { firstName, lastName, avatarUrl };
}

async function fetchMetaSenderPictureUrl(
  senderId: string,
  pageAccessToken: string,
): Promise<string | null> {
  const params = new URLSearchParams({
    redirect: "false",
    type: "normal",
    access_token: pageAccessToken,
  });

  const response = await fetch(
    `https://graph.facebook.com/${META_GRAPH_VERSION}/${encodeURIComponent(senderId)}/picture?${params.toString()}`,
  );
  if (!response.ok) return null;

  const data = (await response.json().catch(() => null)) as {
    data?: { url?: string };
  } | null;
  return data?.data?.url?.trim() || null;
}

/** Facebook Page or Instagram professional account profile photo for outbound UI. */
export async function fetchMetaChannelAvatar(input: {
  channel: "messenger" | "instagram";
  pageId: string;
  pageAccessToken: string;
  instagramBusinessAccountId?: string | null;
}): Promise<string | null> {
  if (input.channel === "instagram" && input.instagramBusinessAccountId) {
    const params = new URLSearchParams({
      fields: "profile_picture_url",
      access_token: input.pageAccessToken,
    });
    const response = await fetch(
      `https://graph.facebook.com/${META_GRAPH_VERSION}/${encodeURIComponent(input.instagramBusinessAccountId)}?${params.toString()}`,
    );
    if (response.ok) {
      const data = (await response.json().catch(() => null)) as {
        profile_picture_url?: string;
      } | null;
      const url = data?.profile_picture_url?.trim();
      if (url) return url;
    }
  }

  return fetchMetaSenderPictureUrl(input.pageId, input.pageAccessToken);
}
