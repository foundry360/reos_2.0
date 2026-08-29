import { NextRequest, NextResponse } from "next/server";
import { isPlatformAdmin } from "@/lib/admin/auth";
import { createClient } from "@/lib/supabase/server";
import { getSupabaseAdmin } from "@/lib/supabase/admin";
import {
  buildCompletedMetaChannelRow,
  buildPendingMetaChannelRow,
} from "@/lib/meta/channel-account";
import {
  decodeMetaOAuthState,
  exchangeMetaOAuthCode,
  isMetaOAuthConfigured,
} from "@/lib/meta/oauth";
import {
  exchangeMetaLongLivedUserToken,
  fetchMetaPages,
  filterMetaPagesForChannel,
} from "@/lib/meta/pages";
import { subscribeMetaPageToAppWebhooks } from "@/lib/meta/subscribe";

function accountRedirect(
  request: NextRequest,
  tenantId: string,
  query?: Record<string, string>,
): NextResponse {
  const url = new URL(`/admin/accounts/${tenantId}`, request.url);
  if (query) {
    for (const [key, value] of Object.entries(query)) {
      url.searchParams.set(key, value);
    }
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
    return accountRedirect(request, state.tenantId, { meta_error: oauthError });
  }

  if (!code) {
    return accountRedirect(request, state.tenantId, { meta_error: "missing_code" });
  }

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user || !(await isPlatformAdmin(user.id))) {
    return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  }

  if (!isMetaOAuthConfigured()) {
    return accountRedirect(request, state.tenantId, { meta_error: "not_configured" });
  }

  try {
    const redirectUri = new URL("/api/oauth/meta/callback", request.url).toString();
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
      return accountRedirect(request, state.tenantId, { meta_error: "server_config" });
    }

    if (pages.length === 0) {
      return accountRedirect(request, state.tenantId, {
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
        connectedBy: user.id,
      });

      const { error } = await admin.from("channel_accounts").upsert(row, {
        onConflict: "tenant_id,channel",
      });

      if (error) {
        return accountRedirect(request, state.tenantId, { meta_error: error.message });
      }

      try {
        await subscribeMetaPageToAppWebhooks(pages[0].id, pages[0].accessToken);
      } catch (error) {
        console.error("Meta Page webhook subscribe failed:", error);
      }

      return accountRedirect(request, state.tenantId);
    }

    const pendingRow = buildPendingMetaChannelRow({
      tenantId: state.tenantId,
      channel: state.channel,
      userAccessToken,
      expiresIn,
      connectedBy: user.id,
    });

    const { error } = await admin.from("channel_accounts").upsert(pendingRow, {
      onConflict: "tenant_id,channel",
    });

    if (error) {
      return accountRedirect(request, state.tenantId, { meta_error: error.message });
    }

    return accountRedirect(request, state.tenantId, { meta_select_page: state.channel });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Meta OAuth failed.";
    return accountRedirect(request, state.tenantId, { meta_error: message });
  }
}
