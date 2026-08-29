import type { MetaChannel } from "@/lib/meta/oauth";
import type { MetaPageOption } from "@/lib/meta/pages";

export interface MetaChannelMetadata {
  user_access_token?: string;
  access_token?: string;
  expires_in?: number | null;
  page_name?: string;
  label?: string;
  connected_at?: string;
  connected_by?: string;
  awaiting_page_selection?: boolean;
  webhooks_subscribed_at?: string;
  instagram_business_account_id?: string | null;
  instagram_username?: string | null;
}

export function buildPendingMetaChannelRow(input: {
  tenantId: string;
  channel: MetaChannel;
  userAccessToken: string;
  expiresIn: number | null;
  connectedBy: string;
}) {
  return {
    tenant_id: input.tenantId,
    channel: input.channel,
    status: "connected" as const,
    external_page_id: null,
    external_account_id: null,
    metadata: {
      user_access_token: input.userAccessToken,
      expires_in: input.expiresIn,
      connected_at: new Date().toISOString(),
      connected_by: input.connectedBy,
      awaiting_page_selection: true,
    } satisfies MetaChannelMetadata,
  };
}

export function buildCompletedMetaChannelRow(input: {
  tenantId: string;
  channel: MetaChannel;
  page: MetaPageOption;
  userAccessToken: string;
  expiresIn: number | null;
  connectedBy: string;
  existingMetadata?: MetaChannelMetadata | null;
}) {
  const label =
    input.channel === "instagram"
      ? input.page.instagramUsername
        ? `@${input.page.instagramUsername.replace(/^@/, "")}`
        : input.page.name
      : input.page.name;

  const previous = input.existingMetadata ?? {};

  return {
    tenant_id: input.tenantId,
    channel: input.channel,
    status: "connected" as const,
    external_page_id: input.page.id,
    external_account_id:
      input.channel === "instagram"
        ? input.page.instagramBusinessAccountId
        : input.page.id,
    metadata: {
      ...previous,
      user_access_token: input.userAccessToken,
      access_token: input.page.accessToken,
      expires_in: input.expiresIn,
      page_name: input.page.name,
      label,
      connected_at: previous.connected_at ?? new Date().toISOString(),
      connected_by: input.connectedBy,
      awaiting_page_selection: false,
      instagram_business_account_id: input.page.instagramBusinessAccountId,
      instagram_username: input.page.instagramUsername,
    } satisfies MetaChannelMetadata,
  };
}
