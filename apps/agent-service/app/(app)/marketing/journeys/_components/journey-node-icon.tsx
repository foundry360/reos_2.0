import type { JourneyNodeType } from "@/lib/journeys/journey-types";
import styles from "./journeys.module.css";

/** Keep in sync with the --node-accent values in journeys.module.css. */
export const JOURNEY_NODE_COLORS: Record<JourneyNodeType, string> = {
  trigger: "#43bd9c",
  ai: "#69aed1",
  condition: "#fba139",
  action: "#abb7c5",
};

export const NODE_TYPE_CLASS: Record<JourneyNodeType, string> = {
  trigger: styles.typeTrigger,
  ai: styles.typeAi,
  condition: styles.typeCondition,
  action: styles.typeAction,
};

export function JourneyNodeGlyph({ type, size = 16 }: { type: JourneyNodeType; size?: number }) {
  const common = {
    width: size,
    height: size,
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 2,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
  };

  switch (type) {
    case "trigger":
      return (
        <svg {...common}>
          <path d="M13 2 4 14h7l-1 8 9-12h-7l1-8z" />
        </svg>
      );
    case "ai":
      return (
        <svg {...common}>
          <path d="M12 3c.5 4.2 2.3 6.5 6.5 7-4.2.5-6 2.8-6.5 7-.5-4.2-2.3-6.5-6.5-7 4.2-.5 6-2.8 6.5-7z" />
          <path d="M19 15c.2 1.6.9 2.4 2.5 2.6-1.6.2-2.3 1-2.5 2.6-.2-1.6-.9-2.4-2.5-2.6 1.6-.2 2.3-1 2.5-2.6z" />
        </svg>
      );
    case "condition":
      return (
        <svg {...common}>
          <path d="M6 4v6a4 4 0 0 0 4 4h8" />
          <path d="M15 11l3 3-3 3" />
          <path d="M6 14v6" />
        </svg>
      );
    case "action":
      return (
        <svg {...common}>
          <path d="M20 6 9 17l-5-5" />
        </svg>
      );
  }
}

export function JourneyNodeIcon({ type }: { type: JourneyNodeType }) {
  return (
    <span
      className={`${styles.typeIcon} ${type === "condition" ? styles.typeIconDiamond : ""} ${NODE_TYPE_CLASS[type]}`}
      aria-hidden
    >
      <span className={styles.typeIconGlyph}>
        <JourneyNodeGlyph type={type} />
      </span>
    </span>
  );
}
