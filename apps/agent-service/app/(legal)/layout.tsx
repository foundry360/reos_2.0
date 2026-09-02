import type { Metadata } from "next";
import { ThemeProvider } from "@/components/theme/theme-provider";

export const metadata: Metadata = {
  title: {
    template: "%s | RealtorOS",
    default: "Legal | RealtorOS",
  },
};

export default function LegalLayout({ children }: { children: React.ReactNode }) {
  return <ThemeProvider preference="light">{children}</ThemeProvider>;
}
