import { createServerClient, type CookieOptions } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";
import { resolvePostLoginPath } from "@/lib/auth/post-login-path";

type CookieToSet = { name: string; value: string; options: CookieOptions };

/**
 * Email invite / confirm links that carry token_hash (SSR-safe).
 * Prefer this over PKCE `code` exchange for admin-sent invites — those
 * never store a code_verifier in the invitee's browser.
 */
export async function GET(request: NextRequest) {
  const { searchParams, origin } = new URL(request.url);
  const tokenHash = searchParams.get("token_hash");
  const type = searchParams.get("type");
  const rawNext = searchParams.get("next") ?? "/overview";

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

  let accepted = false;
  let userId: string | null = null;

  if (tokenHash && type) {
    const { data, error } = await supabase.auth.verifyOtp({
      type: type as "invite" | "signup" | "magiclink" | "recovery" | "email",
      token_hash: tokenHash,
    });
    accepted = !error;
    userId = data.user?.id ?? data.session?.user?.id ?? null;
    if (error) {
      console.error("auth/confirm verifyOtp failed:", error.message);
    }
  }

  const needsPassword = type === "invite" || type === "recovery" || type === "signup";
  let next = "/overview";
  if (accepted && userId && !needsPassword) {
    next = await resolvePostLoginPath(supabase, userId, rawNext);
  }

  const destination = accepted
    ? needsPassword
      ? `${origin}/set-password`
      : `${origin}${next}`
    : `${origin}/login?error=auth_callback_failed`;

  const response = NextResponse.redirect(destination);
  for (const { name, value, options } of cookiesToApply) {
    response.cookies.set(name, value, options);
  }
  return response;
}
