import "./globals.css";
import type { Metadata } from "next";
import { ThemeScript } from "@/components/theme/theme-script";
import { ThemeProvider } from "@/components/theme/theme-provider";
import { cookies } from "next/headers";
import { isThemePreference, THEME_COOKIE, type ThemePreference } from "@/lib/theme";

export const metadata: Metadata = {
  title: "REOS 2.0",
  description: "AI-powered lead engagement for real estate teams",
  icons: {
    icon: [
      { url: "/favicon.ico", sizes: "any" },
      { url: "/icon.png", type: "image/png" },
    ],
    apple: [{ url: "/apple-icon.png", type: "image/png" }],
  },
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
