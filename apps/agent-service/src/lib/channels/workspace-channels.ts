import type { MetaChannelMetadata } from "@/lib/meta/channel-account";
import type { MetaChannel } from "@/lib/meta/oauth";
import { createClient } from "@/lib/supabase/server";

export interface SocialChannelStatus {
  channel: MetaChannel;
  status: "connected" | "disconnected" | "error";
  accountLabel: string | null;
  externalPageId: string | null;
  awaitingPageSelection: boolean;
}

export interface WorkspaceChannels {
  social: SocialChannelStatus[];
  smsNumber: string | null;
}

export const SOCIAL_CHANNELS: MetaChannel[] = ["messenger", "instagram"];

/** Connection status for the workspace Channels page. Never exposes tokens to the client. */
export async function getWorkspaceChannels(tenantId: string): Promise<WorkspaceChannels> {
  const supabase = await createClient();
  const [{ data: rows }, { data: phones }] = await Promise.all([
    supabase
      .from("channel_accounts")
      .select("channel, status, external_page_id, external_account_id, metadata")
      .eq("tenant_id", tenantId)
      .in("channel", SOCIAL_CHANNELS),
    supabase
      .from("tenant_phone_numbers")
      .select("phone_e164, is_primary")
      .eq("tenant_id", tenantId),
  ]);

  const social = SOCIAL_CHANNELS.map((channel): SocialChannelStatus => {
    const row = rows?.find((entry) => entry.channel === channel);
    const metadata = (row?.metadata ?? null) as MetaChannelMetadata | null;
    const status = (row?.status as SocialChannelStatus["status"]) ?? "disconnected";
    const externalPageId = row?.external_page_id?.trim() || null;
    return {
      channel,
      status,
      accountLabel: metadata?.label?.trim() || row?.external_account_id?.trim() || null,
      externalPageId,
      awaitingPageSelection:
        status === "connected" &&
        (!externalPageId || metadata?.awaiting_page_selection === true),
    };
  });

  return {
    social,
    smsNumber: phones?.find((phone) => phone.is_primary)?.phone_e164 ?? null,
  };
}
