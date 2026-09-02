import type { Metadata } from "next";
import { ThemeProvider } from "@/components/theme/theme-provider";

export const metadata: Metadata = {
  title: {
    template: "%s | REOS",
    default: "Legal | REOS",
  },
};

export default function LegalLayout({ children }: { children: React.ReactNode }) {
  return <ThemeProvider preference="light">{children}</ThemeProvider>;
}
