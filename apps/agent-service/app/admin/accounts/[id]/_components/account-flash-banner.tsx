"use client";

import { useEffect, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import styles from "@/components/shell/shell.module.css";

const FLASH_PARAMS = [
  "created",
  "meta_error",
  "google_connected",
  "google_error",
] as const;

interface AccountFlashBannerProps {
  kind: "success" | "error";
  text: string;
}

/** One-shot banner: shows once, then strips flash query params so it does not persist. */
export function AccountFlashBanner({ kind, text }: AccountFlashBannerProps) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [visible, setVisible] = useState(true);

  useEffect(() => {
    const next = new URLSearchParams(searchParams.toString());
    let changed = false;
    for (const key of FLASH_PARAMS) {
      if (next.has(key)) {
        next.delete(key);
        changed = true;
      }
    }
    if (!changed) return;

    const query = next.toString();
    router.replace(query ? `${pathname}?${query}` : pathname, { scroll: false });
  }, [pathname, router, searchParams]);

  useEffect(() => {
    const timer = window.setTimeout(() => setVisible(false), 8000);
    return () => window.clearTimeout(timer);
  }, []);

  if (!visible) return null;

  return <p className={kind === "success" ? styles.success : styles.error}>{text}</p>;
}
