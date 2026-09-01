"use client";

import { useEffect, useState } from "react";
import { currentTimeGridTopPct } from "@/lib/calendar/calendar-date";
import styles from "./calendar.module.css";

interface CalendarCurrentTimeMarkerProps {
  visible: boolean;
}

export function CalendarCurrentTimeMarker({ visible }: CalendarCurrentTimeMarkerProps) {
  const [topPct, setTopPct] = useState<number | null>(() =>
    visible ? currentTimeGridTopPct() : null,
  );

  useEffect(() => {
    if (!visible) {
      setTopPct(null);
      return;
    }

    const tick = () => setTopPct(currentTimeGridTopPct());
    tick();
    const id = window.setInterval(tick, 60_000);
    return () => window.clearInterval(id);
  }, [visible]);

  if (!visible || topPct === null) return null;

  return (
    <div
      className={styles.currentTimeMarker}
      style={{ top: `${topPct}%` }}
      aria-hidden
    >
      <span className={styles.currentTimeDot} />
      <span className={styles.currentTimeLine} />
    </div>
  );
}
