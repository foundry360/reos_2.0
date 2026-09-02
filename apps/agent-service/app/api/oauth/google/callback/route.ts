import { NextRequest, NextResponse } from "next/server";
import { isPlatformAdmin } from "@/lib/admin/auth";
import { createClient } from "@/lib/supabase/server";
import { getSupabaseAdmin } from "@/lib/supabase/admin";
import {
  decodeGoogleOAuthState,
  exchangeGoogleOAuthCode,
  fetchGoogleAccountEmail,
  isGoogleOAuthConfigured,
} from "@/lib/google/oauth";
import { buildOAuthRedirectUri } from "@/lib/oauth/redirect-uri";

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
  const oauthError =
    request.nextUrl.searchParams.get("error_description")?.trim() ??
    request.nextUrl.searchParams.get("error")?.trim();

  const state = decodeGoogleOAuthState(stateRaw);
  if (!state) {
    return NextResponse.json({ error: "Invalid OAuth state." }, { status: 400 });
  }

  if (oauthError) {
    return accountRedirect(request, state.tenantId, { google_error: oauthError });
  }

  if (!code) {
    return accountRedirect(request, state.tenantId, { google_error: "missing_code" });
  }

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user || !(await isPlatformAdmin(user.id))) {
    return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  }

  if (!isGoogleOAuthConfigured()) {
    return accountRedirect(request, state.tenantId, { google_error: "not_configured" });
  }

  try {
    const redirectUri = buildOAuthRedirectUri("/api/oauth/google/callback", request.url);
    const token = await exchangeGoogleOAuthCode(code, redirectUri);
    const accountEmail = await fetchGoogleAccountEmail(token.accessToken);

    const admin = getSupabaseAdmin();
    if (!admin) {
      return accountRedirect(request, state.tenantId, { google_error: "server_config" });
    }

    const { error } = await admin.from("channel_accounts").upsert(
      {
        tenant_id: state.tenantId,
        channel: state.channel,
        status: "connected",
        external_account_id: accountEmail,
        metadata: {
          access_token: token.accessToken,
          refresh_token: token.refreshToken,
          expires_in: token.expiresIn,
          expires_at: token.expiresIn
            ? new Date(Date.now() + token.expiresIn * 1000).toISOString()
            : null,
          scope: token.scope,
          token_type: token.tokenType,
          label: accountEmail,
          connected_at: new Date().toISOString(),
          connected_by: user.id,
        },
      },
      { onConflict: "tenant_id,channel" },
    );

    if (error) {
      return accountRedirect(request, state.tenantId, { google_error: error.message });
    }

    return accountRedirect(request, state.tenantId, { google_connected: state.channel });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Google OAuth failed.";
    return accountRedirect(request, state.tenantId, { google_error: message });
  }
}
