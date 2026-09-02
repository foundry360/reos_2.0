/**
 * OAuth providers require an exact redirect_uri match.
 * Prefer NEXT_PUBLIC_SITE_URL in deployed envs so apex vs www (or previews)
 * cannot send a host Meta/Google have not whitelisted.
 * Localhost keeps using the incoming request host.
 */
export function buildOAuthRedirectUri(callbackPath: string, requestUrl: string): string {
  const path = callbackPath.startsWith("/") ? callbackPath : `/${callbackPath}`;
  const site = process.env.NEXT_PUBLIC_SITE_URL?.trim().replace(/\/$/, "") ?? "";

  if (site && !/localhost|127\.0\.0\.1/i.test(site)) {
    return `${site}${path}`;
  }

  return new URL(path, requestUrl).toString();
}
