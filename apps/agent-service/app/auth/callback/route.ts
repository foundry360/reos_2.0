import { createServerClient, type CookieOptions } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";
import { resolvePostLoginPath } from "@/lib/auth/post-login-path";

type CookieToSet = { name: string; value: string; options: CookieOptions };

/**
 * PKCE callback for flows started in this browser (magic link, OAuth).
 * Admin invite emails should use /auth/confirm?token_hash=… instead —
 * those links have no code_verifier cookie to exchange a `code`.
 */
export async function GET(request: NextRequest) {
  const { searchParams, origin } = new URL(request.url);
  const code = searchParams.get("code");
  const tokenHash = searchParams.get("token_hash");
  const type = searchParams.get("type");
  const rawNext = searchParams.get("next") ?? "/overview";

  // Invite-style links may still land here if redirectTo pointed at callback.
  if (tokenHash && type) {
    const url = new URL("/auth/confirm", origin);
    url.searchParams.set("token_hash", tokenHash);
    url.searchParams.set("type", type);
    url.searchParams.set("next", rawNext);
    return NextResponse.redirect(url);
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

  let accepted = false;
  let userId: string | null = null;

  if (code) {
    const { data, error } = await supabase.auth.exchangeCodeForSession(code);
    accepted = !error;
    userId = data.user?.id ?? data.session?.user?.id ?? null;
    if (error) {
      console.error("auth/callback exchangeCodeForSession failed:", error.message);
    }
  }

  let next = "/overview";
  if (accepted && userId) {
    next = await resolvePostLoginPath(supabase, userId, rawNext);
  }

  const destination = accepted
    ? `${origin}${next}`
    : `${origin}/login?error=auth_callback_failed`;

  const response = NextResponse.redirect(destination);
  for (const { name, value, options } of cookiesToApply) {
    response.cookies.set(name, value, options);
  }
  return response;
}
