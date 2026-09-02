import { NextRequest, NextResponse } from "next/server";
import { isPlatformAdmin } from "@/lib/admin/auth";
import { createClient } from "@/lib/supabase/server";
import {
  buildGoogleOAuthUrl,
  isGoogleOAuthConfigured,
  type GoogleChannel,
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
  const tenantId = request.nextUrl.searchParams.get("tenantId")?.trim() ?? "";
  const channel = request.nextUrl.searchParams.get("channel")?.trim() as GoogleChannel;

  if (!tenantId || (channel !== "email" && channel !== "calendar")) {
    return NextResponse.json({ error: "Invalid request." }, { status: 400 });
  }

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user || !(await isPlatformAdmin(user.id))) {
    return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  }

  if (!isGoogleOAuthConfigured()) {
    return accountRedirect(request, tenantId, { google_error: "not_configured" });
  }

  const redirectUri = buildOAuthRedirectUri("/api/oauth/google/callback", request.url);
  const oauthUrl = buildGoogleOAuthUrl({ tenantId, channel }, redirectUri);

  return NextResponse.redirect(oauthUrl);
}
