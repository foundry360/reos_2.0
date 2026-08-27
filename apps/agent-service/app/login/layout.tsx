import { ThemeProvider } from "@/components/theme/theme-provider";

export default function LoginLayout({ children }: { children: React.ReactNode }) {
  return <ThemeProvider preference="light">{children}</ThemeProvider>;
}
