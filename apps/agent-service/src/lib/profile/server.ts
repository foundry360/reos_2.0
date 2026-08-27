import { createClient } from "@/lib/supabase/server";
import type { ThemePreference } from "@/lib/theme";
import { isThemePreference } from "@/lib/theme";

export interface UserProfile {
  displayName: string;
  avatarUrl: string | null;
  themePreference: ThemePreference;
}

export async function getCurrentProfile(userId: string, email: string): Promise<UserProfile> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("profiles")
    .select("display_name, avatar_url, theme_preference")
    .eq("id", userId)
    .maybeSingle();

  if (error) {
    console.error("Profile lookup failed:", error.message);
  }

  if (!data) {
    const displayName = email.split("@")[0] ?? "User";
    await supabase.from("profiles").upsert({
      id: userId,
      display_name: displayName,
    });
    return { displayName, avatarUrl: null, themePreference: "system" };
  }

  const themePreference = isThemePreference(data.theme_preference ?? "")
    ? data.theme_preference
    : "system";

  return {
    displayName: data.display_name ?? email.split("@")[0] ?? "User",
    avatarUrl: data.avatar_url,
    themePreference,
  };
}
