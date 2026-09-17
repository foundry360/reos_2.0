import type { Metadata } from "next";
import { Plus_Jakarta_Sans } from "next/font/google";
import { ThemeProvider } from "@/components/theme/theme-provider";
import { AuthSessionCatch } from "@/components/auth/auth-session-catch";
import { LandingScrollLock } from "./landing-scroll-lock";

const SITE_URL = "https://www.getreos.app";

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
      <script
        dangerouslySetInnerHTML={{
          __html: `(function(){try{var h=window.location.hash||"";var s=window.location.search||"";var hasCode=/[?&]code=/.test(s);var hasTokenHash=/[?&]token_hash=/.test(s);var hasToken=/access_token|refresh_token/.test(h);var typeMatch=s.match(/[?&]type=([^&]+)/)||h.match(/[?&#]type=([^&]+)/);var type=typeMatch?decodeURIComponent(typeMatch[1]):"";if(hasTokenHash&&type){var conf=new URL("/auth/confirm",window.location.origin);conf.search=s;conf.searchParams.set("next","/set-password");window.location.replace(conf.pathname+conf.search);return;}var passwordFlow=type==="recovery"||type==="invite"||type==="signup"||hasToken||hasCode;if((hasToken||hasCode)&&passwordFlow){window.location.replace("/set-password"+s+h);}}catch(e){}})();`,
        }}
      />
      <AuthSessionCatch />
      <LandingScrollLock />
      <div className={plusJakarta.variable}>{children}</div>
    </ThemeProvider>
  );
}
