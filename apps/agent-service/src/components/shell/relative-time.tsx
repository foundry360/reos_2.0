"use client";

import { useEffect, useState } from "react";
import { formatRelativeTime } from "@/lib/admin/activity-timeline";

/** Stable absolute date for SSR / first paint (matches server + client). */
export function formatStableDate(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  }).format(date);
}

export function formatStableDateTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(date);
}

/**
 * Renders a locale-stable absolute time on SSR, then switches to relative
 * after mount so Date.now() cannot cause hydration mismatches.
 */
export function RelativeTime({
  iso,
  mode = "date",
}: {
  iso: string;
  mode?: "date" | "datetime";
}) {
  const [label, setLabel] = useState(() =>
    mode === "datetime" ? formatStableDateTime(iso) : formatStableDate(iso),
  );

  useEffect(() => {
    setLabel(formatRelativeTime(iso));
  }, [iso]);

  return <>{label}</>;
}
