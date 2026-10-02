"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import {
  buildCompletedMetaChannelRow,
  type MetaChannelMetadata,
} from "@/lib/meta/channel-account";
import type { MetaChannel } from "@/lib/meta/oauth";
import { fetchMetaPages, filterMetaPagesForChannel, type MetaPageOption } from "@/lib/meta/pages";
import { META_PAGE_WEBHOOK_FIELDS, subscribeMetaPageToAppWebhooks } from "@/lib/meta/subscribe";
import { authorizeChannelManager } from "@/lib/tenant/workspace-access";

export interface ActionResult {
  ok: boolean;
  error?: string;
}

const NOT_ALLOWED = "Only workspace owners can manage channels.";

function revalidateTenant(tenantId: string) {
  revalidatePath("/admin");
  revalidatePath(`/admin/accounts/${tenantId}`);
  revalidatePath("/settings/channels");
}

function parseChannel(value: string): MetaChannel | null {
  if (value === "messenger" || value === "instagram") return value;
  return null;
}

async function loadChannelUserToken(
  tenantId: string,
  channel: MetaChannel,
): Promise<{ token: string; expiresIn: number | null; metadata: MetaChannelMetadata } | null> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("channel_accounts")
    .select("metadata")
    .eq("tenant_id", tenantId)
    .eq("channel", channel)
    .maybeSingle();

  if (error || !data) return null;

  const metadata = (data.metadata ?? {}) as MetaChannelMetadata;
  const token =
    metadata.user_access_token?.trim() ||
    metadata.access_token?.trim() ||
    "";

  if (!token) return null;

  return {
    token,
    expiresIn: metadata.expires_in ?? null,
    metadata,
  };
}

export async function listMetaPagesForTenantAction(
  tenantId: string,
  channel: MetaChannel,
): Promise<{ ok: true; pages: MetaPageOption[] } | { ok: false; error: string }> {
  const id = tenantId.trim();
  if (!id) return { ok: false, error: "Missing account id." };
  if (!(await authorizeChannelManager(id))) return { ok: false, error: NOT_ALLOWED };

  const loaded = await loadChannelUserToken(id, channel);
  if (!loaded) {
    return {
      ok: false,
      error: "Reconnect Meta first so we can load Facebook Pages.",
    };
  }

  try {
    const pages = filterMetaPagesForChannel(await fetchMetaPages(loaded.token), channel);
    return { ok: true, pages };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Could not load Facebook Pages.";
    return { ok: false, error: message };
  }
}

export async function completeMetaPageConnectionAction(
  formData: FormData,
): Promise<ActionResult> {
  const tenantId = String(formData.get("tenantId") ?? "").trim();
  const channel = parseChannel(String(formData.get("channel") ?? "").trim());
  const pageId = String(formData.get("pageId") ?? "").trim();

  if (!tenantId) return { ok: false, error: "Missing account id." };
  if (!channel) return { ok: false, error: "Invalid channel." };
  if (!pageId) return { ok: false, error: "Select a Facebook Page." };

  const manager = await authorizeChannelManager(tenantId);
  if (!manager) return { ok: false, error: NOT_ALLOWED };

  const loaded = await loadChannelUserToken(tenantId, channel);
  if (!loaded) {
    return { ok: false, error: "Reconnect Meta first so we can finish Page setup." };
  }

  try {
    const pages = filterMetaPagesForChannel(await fetchMetaPages(loaded.token), channel);
    const page = pages.find((entry) => entry.id === pageId);
    if (!page) {
      return {
        ok: false,
        error:
          channel === "instagram"
            ? "That Page is not available or has no linked Instagram account."
            : "That Facebook Page is not available for this account.",
      };
    }

    const row = buildCompletedMetaChannelRow({
      tenantId,
      channel,
      page,
      userAccessToken: loaded.token,
      expiresIn: loaded.expiresIn,
      connectedBy: manager.userId,
      existingMetadata: loaded.metadata,
    });

    const supabase = await createClient();
    const { error } = await supabase.from("channel_accounts").upsert(row, {
      onConflict: "tenant_id,channel",
    });

    if (error) return { ok: false, error: error.message };

    try {
      await subscribeMetaPageToAppWebhooks(page.id, page.accessToken);
      const { error: metaError } = await supabase.from("channel_accounts").upsert(
        {
          ...row,
          metadata: {
            ...row.metadata,
            webhooks_subscribed_at: new Date().toISOString(),
            webhooks_subscribed_fields: META_PAGE_WEBHOOK_FIELDS,
          },
        },
        { onConflict: "tenant_id,channel" },
      );
      if (metaError) {
        console.error("Meta webhook flag save failed:", metaError);
      }
    } catch (error) {
      console.error("Meta Page webhook subscribe failed:", error);
      // Connection is still saved; webhooks can be re-subscribed later.
    }

    // Tenant rows are writable by platform admins only; owners skip the audit stamp.
    if (manager.platformAdmin) {
      const { error: auditError } = await supabase
        .from("tenants")
        .update({ last_modified_by_id: manager.userId })
        .eq("id", tenantId);
      if (auditError) return { ok: false, error: auditError.message };
    }

    revalidateTenant(tenantId);
    return { ok: true };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Could not connect Facebook Page.";
    return { ok: false, error: message };
  }
}

export async function disconnectMetaChannelAction(
  tenantId: string,
  channel: MetaChannel,
): Promise<ActionResult> {
  const id = tenantId.trim();
  if (!id) return { ok: false, error: "Missing account id." };
  if (!parseChannel(channel)) return { ok: false, error: "Invalid channel." };
  if (!(await authorizeChannelManager(id))) return { ok: false, error: NOT_ALLOWED };

  const supabase = await createClient();
  const { error } = await supabase.from("channel_accounts").upsert(
    {
      tenant_id: id,
      channel,
      status: "disconnected",
      external_page_id: null,
      external_account_id: null,
      metadata: {},
    },
    { onConflict: "tenant_id,channel" },
  );
  if (error) return { ok: false, error: error.message };

  revalidateTenant(id);
  return { ok: true };
}

export async function ensureMetaPageWebhooksAction(
  tenantId: string,
  channel: MetaChannel,
): Promise<ActionResult> {
  const id = tenantId.trim();
  if (!id) return { ok: false, error: "Missing account id." };
  if (!(await authorizeChannelManager(id))) return { ok: false, error: NOT_ALLOWED };

  const supabase = await createClient();
  const { data, error } = await supabase
    .from("channel_accounts")
    .select("external_page_id, metadata")
    .eq("tenant_id", id)
    .eq("channel", channel)
    .eq("status", "connected")
    .maybeSingle();

  if (error) return { ok: false, error: error.message };
  if (!data?.external_page_id) {
    return { ok: false, error: "Connect and select a Facebook Page first." };
  }

  const metadata = (data.metadata ?? {}) as MetaChannelMetadata;
  if (metadata.webhooks_subscribed_fields === META_PAGE_WEBHOOK_FIELDS) return { ok: true };

  const pageToken = metadata.access_token?.trim();
  if (!pageToken) {
    return { ok: false, error: "Missing Page access token. Reconnect Meta." };
  }

  try {
    await subscribeMetaPageToAppWebhooks(data.external_page_id, pageToken);
  } catch (subscribeError) {
    const message =
      subscribeError instanceof Error
        ? subscribeError.message
        : "Could not subscribe Page webhooks.";
    return { ok: false, error: message };
  }

  const { error: updateError } = await supabase
    .from("channel_accounts")
    .update({
      metadata: {
        ...metadata,
        webhooks_subscribed_at: new Date().toISOString(),
        webhooks_subscribed_fields: META_PAGE_WEBHOOK_FIELDS,
      },
    })
    .eq("tenant_id", id)
    .eq("channel", channel);

  if (updateError) return { ok: false, error: updateError.message };
  return { ok: true };
}
