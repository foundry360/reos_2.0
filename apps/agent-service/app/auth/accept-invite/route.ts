import { createServerClient, type CookieOptions } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";
import { verifyTenantInviteToken } from "@/lib/auth/invite-token";
import { getSupabaseAdmin } from "@/lib/supabase/admin";

type CookieToSet = { name: string; value: string; options: CookieOptions };

/**
 * App-issued invite link. Generates a fresh Supabase OTP at click time and
 * consumes it in the same request — so double-clicks / re-adds cannot leave
 * the user with a stale token_hash.
 */
export async function GET(request: NextRequest) {
  const { searchParams, origin } = new URL(request.url);
  const token = searchParams.get("token") ?? "";
  const verified = verifyTenantInviteToken(token);

  if (!verified.ok) {
    console.error("auth/accept-invite token error:", verified.error);
    return NextResponse.redirect(`${origin}/login?error=auth_callback_failed`);
  }

  const admin = getSupabaseAdmin();
  if (!admin) {
    return NextResponse.redirect(`${origin}/login?error=auth_callback_failed`);
  }

  const email = verified.email;

  // Prefer magiclink for existing users; invite creates the auth user if needed.
  let linkType: "magiclink" | "invite" = "magiclink";
  let { data: linkData, error: linkError } = await admin.auth.admin.generateLink({
    type: "magiclink",
    email,
  });

  if (linkError) {
    const invite = await admin.auth.admin.generateLink({
      type: "invite",
      email,
    });
    linkData = invite.data;
    linkError = invite.error;
    linkType = "invite";
  }

  const tokenHash = linkData?.properties?.hashed_token;
  if (linkError || !tokenHash) {
    console.error("auth/accept-invite generateLink failed:", linkError?.message);
    return NextResponse.redirect(`${origin}/login?error=auth_callback_failed`);
  }

  const cookiesToApply: CookieToSet[] = [];
  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return request.cookies.getAll();
        },
        setAll(cookiesToSet: CookieToSet[]) {
          cookiesToSet.forEach(({ name, value }) => {
            request.cookies.set(name, value);
          });
          cookiesToApply.push(...cookiesToSet);
        },
      },
    },
  );

  const { error: verifyError } = await supabase.auth.verifyOtp({
    type: linkType,
    token_hash: tokenHash,
  });

  if (verifyError) {
    console.error("auth/accept-invite verifyOtp failed:", verifyError.message);
    return NextResponse.redirect(`${origin}/login?error=auth_callback_failed`);
  }

  const response = NextResponse.redirect(`${origin}/set-password`);
  for (const { name, value, options } of cookiesToApply) {
    response.cookies.set(name, value, options);
  }
  return response;
}
