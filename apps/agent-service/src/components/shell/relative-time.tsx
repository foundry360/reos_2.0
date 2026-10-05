"use client";

import { useEffect, useState } from "react";
import { formatRelativeTime } from "@/lib/admin/activity-timeline";
import { formatStableDate, formatStableDateTime } from "./format-date";

// Server components must import these from ./format-date, not from this client module.
export { formatStableDate, formatStableDateTime };

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
