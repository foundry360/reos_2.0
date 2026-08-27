import { NextRequest, NextResponse } from "next/server";
import { isPlatformAdmin } from "@/lib/admin/auth";
import { createClient } from "@/lib/supabase/server";
import { getSupabaseAdmin } from "@/lib/supabase/admin";
import {
  decodeMetaOAuthState,
  exchangeMetaOAuthCode,
  isMetaOAuthConfigured,
} from "@/lib/meta/oauth";

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
    const token = await exchangeMetaOAuthCode(code, redirectUri);

    const admin = getSupabaseAdmin();
    if (!admin) {
      return accountRedirect(request, state.tenantId, { meta_error: "server_config" });
    }

    const { error } = await admin.from("channel_accounts").upsert(
      {
        tenant_id: state.tenantId,
        channel: state.channel,
        status: "connected",
        metadata: {
          access_token: token.accessToken,
          expires_in: token.expiresIn,
          connected_at: new Date().toISOString(),
          connected_by: user.id,
        },
      },
      { onConflict: "tenant_id,channel" },
    );

    if (error) {
      return accountRedirect(request, state.tenantId, { meta_error: error.message });
    }

    return accountRedirect(request, state.tenantId, { meta_connected: state.channel });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Meta OAuth failed.";
    return accountRedirect(request, state.tenantId, { meta_error: message });
  }
}
