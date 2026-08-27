import { NextRequest, NextResponse } from "next/server";
import { isPlatformAdmin } from "@/lib/admin/auth";
import { createClient } from "@/lib/supabase/server";
import {
  buildMetaOAuthUrl,
  isMetaOAuthConfigured,
  type MetaChannel,
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
  const tenantId = request.nextUrl.searchParams.get("tenantId")?.trim() ?? "";
  const channel = request.nextUrl.searchParams.get("channel")?.trim() as MetaChannel;

  if (!tenantId || (channel !== "messenger" && channel !== "instagram")) {
    return NextResponse.json({ error: "Invalid request." }, { status: 400 });
  }

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user || !(await isPlatformAdmin(user.id))) {
    return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  }

  if (!isMetaOAuthConfigured()) {
    return accountRedirect(request, tenantId, { meta_error: "not_configured" });
  }

  const redirectUri = new URL("/api/oauth/meta/callback", request.url).toString();
  const oauthUrl = buildMetaOAuthUrl({ tenantId, channel }, redirectUri);

  return NextResponse.redirect(oauthUrl);
}
