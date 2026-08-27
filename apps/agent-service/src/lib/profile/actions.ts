"use server";

import { revalidatePath } from "next/cache";
import { cookies } from "next/headers";
import { createClient } from "@/lib/supabase/server";
import { isThemePreference, THEME_COOKIE, type ThemePreference } from "@/lib/theme";

const MAX_BYTES = 5 * 1024 * 1024;
const ALLOWED_TYPES = new Set(["image/jpeg", "image/png", "image/webp", "image/gif"]);

function extForMime(mime: string): string {
  switch (mime) {
    case "image/png":
      return "png";
    case "image/webp":
      return "webp";
    case "image/gif":
      return "gif";
    default:
      return "jpg";
  }
}

export async function uploadAvatarAction(
  formData: FormData,
): Promise<{ ok: boolean; error?: string }> {
  const file = formData.get("avatar");
  if (!(file instanceof File) || file.size === 0) {
    return { ok: false, error: "Choose an image file." };
  }

  if (!ALLOWED_TYPES.has(file.type)) {
    return { ok: false, error: "Use JPEG, PNG, WebP, or GIF." };
  }

  if (file.size > MAX_BYTES) {
    return { ok: false, error: "Image must be 5 MB or smaller." };
  }

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return { ok: false, error: "Not signed in." };
  }

  const ext = extForMime(file.type);
  const path = `${user.id}/avatar.${ext}`;
  const bytes = Buffer.from(await file.arrayBuffer());

  const { error: uploadError } = await supabase.storage.from("avatars").upload(path, bytes, {
    upsert: true,
    contentType: file.type,
    cacheControl: "3600",
  });

  if (uploadError) {
    return { ok: false, error: uploadError.message };
  }

  const {
    data: { publicUrl },
  } = supabase.storage.from("avatars").getPublicUrl(path);

  const avatarUrl = `${publicUrl}?v=${Date.now()}`;

  const { data: existing } = await supabase
    .from("profiles")
    .select("display_name")
    .eq("id", user.id)
    .maybeSingle();

  const { error: profileError } = await supabase.from("profiles").upsert({
    id: user.id,
    display_name: existing?.display_name ?? user.email?.split("@")[0] ?? "User",
    avatar_url: avatarUrl,
  });

  if (profileError) {
    return { ok: false, error: profileError.message };
  }

  revalidatePath("/", "layout");
  revalidatePath("/admin", "layout");
  revalidatePath("/admin/settings");
  return { ok: true };
}

export async function removeAvatarAction(): Promise<{ ok: boolean; error?: string }> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return { ok: false, error: "Not signed in." };
  }

  const { data: files } = await supabase.storage.from("avatars").list(user.id);
  if (files?.length) {
    const paths = files.map((f) => `${user.id}/${f.name}`);
    await supabase.storage.from("avatars").remove(paths);
  }

  const { error } = await supabase
    .from("profiles")
    .update({ avatar_url: null })
    .eq("id", user.id);

  if (error) {
    return { ok: false, error: error.message };
  }

  revalidatePath("/", "layout");
  revalidatePath("/admin", "layout");
  revalidatePath("/admin/settings");
  return { ok: true };
}

export async function updateDisplayNameAction(
  formData: FormData,
): Promise<{ ok: boolean; error?: string }> {
  const raw = formData.get("displayName");
  if (typeof raw !== "string" || !raw.trim()) {
    return { ok: false, error: "Display name is required." };
  }

  const displayName = raw.trim().slice(0, 80);

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return { ok: false, error: "Not signed in." };
  }

  const { error } = await supabase.from("profiles").upsert({
    id: user.id,
    display_name: displayName,
  });

  if (error) {
    return { ok: false, error: error.message };
  }

  revalidatePath("/", "layout");
  revalidatePath("/admin", "layout");
  revalidatePath("/admin/settings");
  return { ok: true };
}

export async function updateThemeAction(
  theme: ThemePreference,
): Promise<{ ok: boolean; error?: string }> {
  if (!isThemePreference(theme)) {
    return { ok: false, error: "Invalid theme." };
  }

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return { ok: false, error: "Not signed in." };
  }

  const { error } = await supabase.from("profiles").upsert({
    id: user.id,
    theme_preference: theme,
  });

  if (error) {
    return { ok: false, error: error.message };
  }

  const cookieStore = await cookies();
  cookieStore.set(THEME_COOKIE, theme, {
    path: "/",
    maxAge: 60 * 60 * 24 * 365,
    sameSite: "lax",
  });

  revalidatePath("/", "layout");
  revalidatePath("/admin", "layout");
  revalidatePath("/admin/settings");
  return { ok: true };
}
