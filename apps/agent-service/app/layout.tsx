import "./globals.css";
import type { Metadata } from "next";
import { ThemeScript } from "@/components/theme/theme-script";
import { ThemeProvider } from "@/components/theme/theme-provider";
import { cookies } from "next/headers";
import { isThemePreference, THEME_COOKIE, type ThemePreference } from "@/lib/theme";

export const metadata: Metadata = {
  metadataBase: new URL(process.env.NEXT_PUBLIC_SITE_URL || "https://getreos.app"),
  title: {
    default: "RealtorOS",
    template: "%s | RealtorOS",
  },
  description:
    "RealtorOS is an intelligent CRM and operating system for real estate professionals.",
};

export default async function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const cookieStore = await cookies();
  const cookieTheme = cookieStore.get(THEME_COOKIE)?.value ?? "";
  const themePreference: ThemePreference = isThemePreference(cookieTheme)
    ? cookieTheme
    : "system";

  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <ThemeScript />
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
        <link
          href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap"
          rel="stylesheet"
        />
      </head>
      <body>
        <ThemeProvider preference={themePreference}>{children}</ThemeProvider>
      </body>
    </html>
  );
}
