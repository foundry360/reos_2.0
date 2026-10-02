import type { JourneyNodeType } from "@/lib/journeys/journey-types";
import styles from "./journeys.module.css";

export const NODE_TYPE_CLASS: Record<JourneyNodeType, string> = {
  trigger: styles.typeTrigger,
  ai: styles.typeAi,
  condition: styles.typeCondition,
  action: styles.typeAction,
};

function Glyph({ type }: { type: JourneyNodeType }) {
  const common = {
    width: 16,
    height: 16,
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
          <circle cx="6" cy="5" r="2" />
          <circle cx="6" cy="19" r="2" />
          <circle cx="18" cy="12" r="2" />
          <path d="M6 7v10M6 12h4a4 4 0 0 0 4-4V8M14 12h2" />
        </svg>
      );
    case "action":
      return (
        <svg {...common}>
          <path d="M5 12h14M13 6l6 6-6 6" />
        </svg>
      );
  }
}

export function JourneyNodeIcon({ type }: { type: JourneyNodeType }) {
  return (
    <span className={`${styles.typeIcon} ${NODE_TYPE_CLASS[type]}`} aria-hidden>
      <Glyph type={type} />
    </span>
  );
}
