import { NextRequest, NextResponse } from "next/server";
import { getSupabaseAdmin } from "@/lib/supabase/admin";
import {
  buildCompletedMetaChannelRow,
  buildPendingMetaChannelRow,
} from "@/lib/meta/channel-account";
import {
  decodeMetaOAuthState,
  exchangeMetaOAuthCode,
  isMetaOAuthConfigured,
  metaConnectReturnPath,
  type MetaOAuthState,
} from "@/lib/meta/oauth";
import {
  exchangeMetaLongLivedUserToken,
  fetchMetaPages,
  filterMetaPagesForChannel,
} from "@/lib/meta/pages";
import { META_PAGE_WEBHOOK_FIELDS, subscribeMetaPageToAppWebhooks } from "@/lib/meta/subscribe";
import { buildOAuthRedirectUri } from "@/lib/oauth/redirect-uri";
import { authorizeChannelManager } from "@/lib/tenant/workspace-access";

function returnRedirect(
  request: NextRequest,
  state: MetaOAuthState,
  query?: Record<string, string>,
): NextResponse {
  const url = new URL(metaConnectReturnPath(state), request.url);
  for (const [key, value] of Object.entries(query ?? {})) {
    url.searchParams.set(key, value);
  }
  return NextResponse.redirect(url);
}

export async function GET(request: NextRequest) {
  const code = request.nextUrl.searchParams.get("code")?.trim() ?? "";
  const stateRaw = request.nextUrl.searchParams.get("state")?.trim() ?? "";
  const oauthError = request.nextUrl.searchParams.get("error_description")?.trim();

  const state = decodeMetaOAuthState(stateRaw);
  if (!state) {
    return NextResponse.json({ error: "Invalid OAuth state." }, { status: 400 });
  }

  if (oauthError) {
    return returnRedirect(request, state, { meta_error: oauthError });
  }

  if (!code) {
    return returnRedirect(request, state, { meta_error: "missing_code" });
  }

  const manager = await authorizeChannelManager(state.tenantId);
  if (!manager) {
    return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  }

  if (!isMetaOAuthConfigured()) {
    return returnRedirect(request, state, { meta_error: "not_configured" });
  }

  try {
    const redirectUri = buildOAuthRedirectUri("/api/oauth/meta/callback", request.url);
    const shortLived = await exchangeMetaOAuthCode(code, redirectUri);

    let userAccessToken = shortLived.accessToken;
    let expiresIn = shortLived.expiresIn;
    try {
      const longLived = await exchangeMetaLongLivedUserToken(shortLived.accessToken);
      userAccessToken = longLived.accessToken;
      expiresIn = longLived.expiresIn;
    } catch {
      // Short-lived token still works for page listing; continue.
    }

    const pages = filterMetaPagesForChannel(await fetchMetaPages(userAccessToken), state.channel);

    const admin = getSupabaseAdmin();
    if (!admin) {
      return returnRedirect(request, state, { meta_error: "server_config" });
    }

    if (pages.length === 0) {
      return returnRedirect(request, state, {
        meta_error:
          state.channel === "instagram"
            ? "No Facebook Pages with a linked Instagram professional account were found."
            : "No Facebook Pages were found for this Facebook account.",
      });
    }

    if (pages.length === 1) {
      const row = buildCompletedMetaChannelRow({
        tenantId: state.tenantId,
        channel: state.channel,
        page: pages[0],
        userAccessToken,
        expiresIn,
        connectedBy: manager.userId,
      });

      const { error } = await admin.from("channel_accounts").upsert(row, {
        onConflict: "tenant_id,channel",
      });

      if (error) {
        return returnRedirect(request, state, { meta_error: error.message });
      }

      try {
        await subscribeMetaPageToAppWebhooks(pages[0].id, pages[0].accessToken);
        await admin
          .from("channel_accounts")
          .update({
            metadata: {
              ...row.metadata,
              webhooks_subscribed_at: new Date().toISOString(),
              webhooks_subscribed_fields: META_PAGE_WEBHOOK_FIELDS,
            },
          })
          .eq("tenant_id", state.tenantId)
          .eq("channel", state.channel);
      } catch (error) {
        console.error("Meta Page webhook subscribe failed:", error);
      }

      return returnRedirect(request, state, { meta_connected: state.channel });
    }

    const pendingRow = buildPendingMetaChannelRow({
      tenantId: state.tenantId,
      channel: state.channel,
      userAccessToken,
      expiresIn,
      connectedBy: manager.userId,
    });

    const { error } = await admin.from("channel_accounts").upsert(pendingRow, {
      onConflict: "tenant_id,channel",
    });

    if (error) {
      return returnRedirect(request, state, { meta_error: error.message });
    }

    return returnRedirect(request, state, { meta_select_page: state.channel });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Meta OAuth failed.";
    return returnRedirect(request, state, { meta_error: message });
  }
}
