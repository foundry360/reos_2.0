import type { Metadata } from "next";
import { Plus_Jakarta_Sans } from "next/font/google";
import { ThemeProvider } from "@/components/theme/theme-provider";
import { LandingScrollLock } from "./landing-scroll-lock";

const SITE_URL = "https://getreos.app";

const plusJakarta = Plus_Jakarta_Sans({
  subsets: ["latin"],
  weight: ["400", "500", "600", "700", "800"],
  display: "swap",
  variable: "--font-landing",
});

export const metadata: Metadata = {
  metadataBase: new URL(SITE_URL),
  title: {
    absolute: "RealtorOS | The Operating System for Modern Real Estate",
  },
  description:
    "RealtorOS is an intelligent CRM and operating system for real estate professionals, bringing leads, contacts, conversations, opportunities, marketing, automation, and AI together in one platform.",
  alternates: {
    canonical: SITE_URL,
  },
  openGraph: {
    type: "website",
    url: SITE_URL,
    siteName: "RealtorOS",
    title: "RealtorOS | The Operating System for Modern Real Estate",
    description:
      "RealtorOS is an intelligent CRM and operating system for real estate professionals, bringing leads, contacts, conversations, opportunities, marketing, automation, and AI together in one platform.",
    images: [
      {
        url: "/realtoros-icon-1024.png",
        width: 1024,
        height: 1024,
        alt: "RealtorOS",
      },
    ],
  },
  twitter: {
    card: "summary_large_image",
    title: "RealtorOS | The Operating System for Modern Real Estate",
    description:
      "An intelligent CRM and operating system for real estate professionals by Referral Partners, LLC.",
    images: ["/realtoros-icon-1024.png"],
  },
  robots: {
    index: true,
    follow: true,
  },
};

export default function MarketingLayout({ children }: { children: React.ReactNode }) {
  return (
    <ThemeProvider preference="light">
      <LandingScrollLock />
      <div className={plusJakarta.variable}>{children}</div>
    </ThemeProvider>
  );
}
