import { getEnv } from "@/lib/env";
import type { getSupabaseAdmin } from "@/lib/supabase/admin";
import { findAuthUserByEmail } from "@/lib/admin/platform-admin-actions";

type AdminClient = NonNullable<ReturnType<typeof getSupabaseAdmin>>;

function passwordSetupRedirect(origin: string): string {
  return `${origin}/set-password`;
}

function isRateLimitError(message: string): boolean {
  return /rate.?limit/i.test(message);
}

export type SendPasswordSetupResult =
  | { ok: true; userId: string; emailed: true }
  | { ok: true; userId: string; emailed: false; rateLimited: true }
  | { ok: false; error: string };

/**
 * Create/invite auth user and email them a link that lands on /set-password.
 * New users: Supabase invite email.
 * Existing users: password recovery email (same set-password landing).
 * If Supabase's mailer rate-limits, still ensures the auth user exists and
 * reports rateLimited so the admin UI can offer an accept-invite link.
 */
export async function sendPasswordSetupEmail(
  admin: AdminClient,
  email: string,
  origin: string,
  existingUserId: string | null,
): Promise<SendPasswordSetupResult> {
  const redirectTo = passwordSetupRedirect(origin);

  if (!existingUserId) {
    const { data, error } = await admin.auth.admin.inviteUserByEmail(email, {
      redirectTo,
    });

    if (!error) {
      const userId = data.user?.id;
      if (!userId) return { ok: false, error: "Invite created but no user id was returned." };
      return { ok: true, userId, emailed: true };
    }

    if (!isRateLimitError(error.message)) {
      return { ok: false, error: error.message };
    }

    // Rate limited: create the auth user without sending mail.
    const created = await admin.auth.admin.createUser({
      email,
      email_confirm: true,
    });
    if (created.error) {
      const recovered = await findAuthUserByEmail(admin, email);
      if (!recovered) return { ok: false, error: created.error.message };
      return { ok: true, userId: recovered.id, emailed: false, rateLimited: true };
    }
    const userId = created.data.user?.id;
    if (!userId) return { ok: false, error: "Could not create auth user after rate limit." };
    return { ok: true, userId, emailed: false, rateLimited: true };
  }

  const env = getEnv();
  const url = env.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey = env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !anonKey) {
    return { ok: false, error: "Server configuration error (Supabase)." };
  }

  const response = await fetch(`${url}/auth/v1/recover`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      apikey: anonKey,
      Authorization: `Bearer ${anonKey}`,
    },
    body: JSON.stringify({
      email,
      redirect_to: redirectTo,
    }),
  });

  if (response.ok) {
    return { ok: true, userId: existingUserId, emailed: true };
  }

  const body = await response.text();
  if (isRateLimitError(body) || response.status === 429) {
    return { ok: true, userId: existingUserId, emailed: false, rateLimited: true };
  }

  return { ok: false, error: body || "Could not send password setup email." };
}
