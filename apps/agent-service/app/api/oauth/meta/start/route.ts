import { NextRequest, NextResponse } from "next/server";
import {
  buildMetaOAuthUrl,
  isMetaOAuthConfigured,
  metaConnectReturnPath,
  type MetaChannel,
  type MetaOAuthState,
} from "@/lib/meta/oauth";
import { buildOAuthRedirectUri } from "@/lib/oauth/redirect-uri";
import { resolveCurrentTenant } from "@/lib/tenant/current-tenant";
import { authorizeChannelManager } from "@/lib/tenant/workspace-access";

function returnRedirect(
  request: NextRequest,
  state: Pick<MetaOAuthState, "tenantId" | "returnTo">,
  query?: Record<string, string>,
): NextResponse {
  const url = new URL(metaConnectReturnPath(state), request.url);
  for (const [key, value] of Object.entries(query ?? {})) {
    url.searchParams.set(key, value);
  }
  return NextResponse.redirect(url);
}

export async function GET(request: NextRequest) {
  const channel = request.nextUrl.searchParams.get("channel")?.trim() as MetaChannel;
  const returnTo =
    request.nextUrl.searchParams.get("returnTo") === "settings" ? "settings" : "admin";

  // Workspace settings always act on the active workspace, never a client-supplied id.
  const tenantId =
    returnTo === "settings"
      ? ((await resolveCurrentTenant()).tenantId ?? "")
      : (request.nextUrl.searchParams.get("tenantId")?.trim() ?? "");

  if (!tenantId || (channel !== "messenger" && channel !== "instagram")) {
    return NextResponse.json({ error: "Invalid request." }, { status: 400 });
  }

  if (!(await authorizeChannelManager(tenantId))) {
    return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  }

  const state: MetaOAuthState = { tenantId, channel, returnTo };

  if (!isMetaOAuthConfigured()) {
    return returnRedirect(request, state, { meta_error: "not_configured" });
  }

  const redirectUri = buildOAuthRedirectUri("/api/oauth/meta/callback", request.url);
  return NextResponse.redirect(buildMetaOAuthUrl(state, redirectUri));
}
