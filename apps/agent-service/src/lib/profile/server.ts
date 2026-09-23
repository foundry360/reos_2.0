import { createClient } from "@/lib/supabase/server";
import type { ThemePreference } from "@/lib/theme";
import { isThemePreference } from "@/lib/theme";

export interface UserProfile {
  displayName: string;
  avatarUrl: string | null;
  themePreference: ThemePreference;
  /** Preferred CRM reply-to; null means use login email. */
  replyToEmail: string | null;
}

type ProfileRow = {
  display_name: string | null;
  avatar_url: string | null;
  theme_preference: string | null;
  reply_to_email?: string | null;
};

export async function getCurrentProfile(userId: string, email: string): Promise<UserProfile> {
  const supabase = await createClient();
  let { data, error } = await supabase
    .from("profiles")
    .select("display_name, avatar_url, theme_preference, reply_to_email")
    .eq("id", userId)
    .maybeSingle();

  if (error && /reply_to_email/i.test(error.message)) {
    ({ data, error } = await supabase
      .from("profiles")
      .select("display_name, avatar_url, theme_preference")
      .eq("id", userId)
      .maybeSingle());
  }

  if (error) {
    console.error("Profile lookup failed:", error.message);
  }

  if (!data) {
    const displayName = email.split("@")[0] ?? "User";
    await supabase.from("profiles").upsert({
      id: userId,
      display_name: displayName,
      theme_preference: "light",
    });
    return {
      displayName,
      avatarUrl: null,
      themePreference: "light",
      replyToEmail: null,
    };
  }

  const row = data as ProfileRow;
  const themePreference = isThemePreference(row.theme_preference ?? "")
    ? (row.theme_preference as ThemePreference)
    : "light";

  const replyTo =
    typeof row.reply_to_email === "string" ? row.reply_to_email.trim() || null : null;

  return {
    displayName: row.display_name ?? email.split("@")[0] ?? "User",
    avatarUrl: row.avatar_url,
    themePreference,
    replyToEmail: replyTo,
  };
}
