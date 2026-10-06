import {
  appendMessage,
  resolveInboundContact,
  resolveInboundTenantId,
  updateContactFields,
} from "@/lib/db/contacts";
import { isSupabaseConfigured } from "@/lib/env";
import { getSupabaseAdmin } from "@/lib/supabase/admin";
import type { MetaChannelMetadata } from "@/lib/meta/channel-account";
import { fetchMetaSenderProfile } from "@/lib/meta/profile";
import { sendMetaTextMessage } from "@/lib/meta/send";
import type { MetaWebhookMessage } from "@/lib/meta/webhook";
import { runProviderInboundTurn, type InboundTurnDeps } from "@/lib/inbound-turn";

export interface HandleMetaInboundResult {
  ok: boolean;
  contactId?: string;
  tenantId?: string;
  playbook?: string;
  skipped?: string;
  sent?: boolean;
}

export async function loadPageAccessToken(
  tenantId: string,
  channel: MetaWebhookMessage["channel"],
  pageOrAccountId: string,
): Promise<string | null> {
  const db = getSupabaseAdmin();
  if (!db) return null;

  const { data } = await db
    .from("channel_accounts")
    .select("metadata")
    .eq("tenant_id", tenantId)
    .eq("channel", channel)
    .eq("status", "connected")
    .or(
      `external_page_id.eq.${pageOrAccountId},external_account_id.eq.${pageOrAccountId}`,
    )
    .maybeSingle();

  const metadata = (data?.metadata ?? {}) as MetaChannelMetadata;
  return metadata.access_token?.trim() || null;
}

export interface MetaInboundDeps {
  resolveTenantId: typeof resolveInboundTenantId;
  loadPageToken: typeof loadPageAccessToken;
  fetchProfile: typeof fetchMetaSenderProfile;
  resolveContact: typeof resolveInboundContact;
  sendText: typeof sendMetaTextMessage;
  turn?: InboundTurnDeps;
}

const liveMetaDeps: MetaInboundDeps = {
  resolveTenantId: resolveInboundTenantId,
  loadPageToken: loadPageAccessToken,
  fetchProfile: fetchMetaSenderProfile,
  resolveContact: resolveInboundContact,
  sendText: sendMetaTextMessage,
};

/** Persist inbound DMs and Page-sent echoes; run agents on inbound only. */
export async function handleInboundMetaMessage(
  message: MetaWebhookMessage,
  deps: MetaInboundDeps = liveMetaDeps,
): Promise<HandleMetaInboundResult> {
  if (!isSupabaseConfigured()) {
    return { ok: false, skipped: "supabase_not_configured" };
  }

  const inbound = {
    channel: message.channel,
    from: message.contactExternalId,
    to: message.pageOrAccountId,
  };

  const tenantId = await deps.resolveTenantId(inbound);
  if (!tenantId) {
    return { ok: false, skipped: "tenant_or_contact_unresolved" };
  }

  const pageToken = await deps.loadPageToken(
    tenantId,
    message.channel,
    message.pageOrAccountId,
  );

  // Only fetch / create profile on inbound — echoes need an existing thread contact.
  let profile: {
    firstName: string | null;
    lastName: string | null;
    avatarUrl: string | null;
  } | null = null;
  if (message.direction === "inbound" && pageToken) {
    profile = await deps.fetchProfile(
      message.contactExternalId,
      pageToken,
      message.channel,
    );
  }

  const ctx = await deps.resolveContact(
    inbound,
    profile ?? undefined,
    { createIfMissing: message.direction === "inbound" },
  );
  if (!ctx.contactId || ctx.accountId === "default-tenant") {
    return {
      ok: false,
      skipped:
        message.direction === "outbound"
          ? "echo_without_contact"
          : "tenant_or_contact_unresolved",
    };
  }

  if (profile) {
    const updates: Record<string, string | null> = {};
    if (!ctx.firstName && (profile.firstName || profile.lastName)) {
      updates.first_name = profile.firstName;
      updates.last_name = profile.lastName;
    }
    if (profile.avatarUrl) {
      updates.avatar_url = profile.avatarUrl;
    }
    if (Object.keys(updates).length > 0) {
      await updateContactFields(ctx.contactId, updates);
    }
  }

  // Page replies from Messenger also arrive as echoes — skip near-duplicates
  // from REOS-originated sends we already stored (agent or human UI).
  if (message.direction === "outbound") {
    const db = getSupabaseAdmin();
    if (db) {
      const since = new Date(Date.now() - 2 * 60 * 1000).toISOString();
      const { data: dup } = await db
        .from("messages")
        .select("id")
        .eq("tenant_id", tenantId)
        .eq("contact_id", ctx.contactId)
        .eq("channel", message.channel)
        .eq("direction", "outbound")
        .eq("body", message.text)
        .gte("created_at", since)
        .limit(1)
        .maybeSingle();
      if (dup) {
        return {
          ok: true,
          contactId: ctx.contactId,
          tenantId,
          skipped: "echo_duplicate",
        };
      }
    }

    await appendMessage({
      tenantId,
      contactId: ctx.contactId,
      channel: message.channel,
      direction: "outbound",
      body: message.text,
    });

    return { ok: true, contactId: ctx.contactId, tenantId, playbook: "none" };
  }

  const text = message.text?.trim() ?? "";
  if (!text) {
    return {
      ok: true,
      contactId: ctx.contactId,
      tenantId,
      skipped: "empty_body",
    };
  }

  // Inbound: claim (mid) → compliance → coordinator → LLM → persist → Graph reply.
  // A redelivered mid is a duplicate: no AI turn and no reply.
  const turn = await runProviderInboundTurn(
    { ctx, body: text, channel: message.channel, providerMessageId: message.mid },
    deps.turn,
  );
  if (turn.status === "duplicate") {
    return { ok: true, contactId: ctx.contactId, tenantId, skipped: "duplicate" };
  }
  const result = turn.result;

  let sent = false;
  if (result.reply && pageToken) {
    const sendResult = await deps.sendText({
      pageAccessToken: pageToken,
      recipientId: message.contactExternalId,
      text: result.reply,
    });
    if (sendResult.ok) {
      sent = true;
    } else {
      console.error("Meta agent reply send failed:", sendResult.error);
    }
  } else if (result.reply && !pageToken) {
    console.warn("Meta agent reply skipped: missing page access token");
  }

  return {
    ok: true,
    contactId: ctx.contactId,
    tenantId,
    playbook: result.playbook,
    sent,
  };
}
