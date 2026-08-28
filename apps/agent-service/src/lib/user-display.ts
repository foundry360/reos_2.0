/** Initials from a display name (first + last) with email fallback. */
export function profileInitials(
  displayName: string | null | undefined,
  email?: string | null,
): string {
  const name = displayName?.trim();
  if (name) {
    const parts = name.split(/\s+/).filter(Boolean);
    if (parts.length >= 2) {
      return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
    }
    return name.slice(0, 2).toUpperCase();
  }
  if (email?.trim()) return userInitials(email);
  return "?";
}

export function userInitials(email: string): string {
  const local = email.split("@")[0] ?? "?";
  const parts = local.split(/[._-]+/).filter(Boolean);
  if (parts.length >= 2) {
    return (parts[0][0] + parts[1][0]).toUpperCase();
  }
  return local.slice(0, 2).toUpperCase();
}

export function accountInitials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length >= 2) {
    return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
  }
  return name.slice(0, 2).toUpperCase();
}

export function resolveProfileAvatarUrl(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  if (!trimmed) return null;
  if (/^https?:\/\//i.test(trimmed)) return trimmed;

  const base = process.env.NEXT_PUBLIC_SUPABASE_URL?.replace(/\/$/, "");
  if (!base) return null;

  const path = trimmed.replace(/^\/+/, "");
  if (path.startsWith("storage/v1/object/public/")) {
    return `${base}/${path}`;
  }
  if (path.startsWith("avatars/")) {
    return `${base}/storage/v1/object/public/${path}`;
  }
  return `${base}/storage/v1/object/public/avatars/${path}`;
}
