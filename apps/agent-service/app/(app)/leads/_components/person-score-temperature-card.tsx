"use client";

import styles from "@/components/shell/shell.module.css";
import { useLiveQualification } from "../_lib/use-live-qualification";

const SCORE_TRACK = "#e8eef4";
const SCORE_FILL = "#487095";

const TEMP_COLORS = {
  Hot: "#c45c26",
  Warm: "#d4a017",
  Cold: "#55a9db",
  empty: "#c5d0db",
} as const;

function Donut({
  value,
  max,
  color,
  label,
  centerPrimary,
  centerSecondary,
}: {
  value: number;
  max: number;
  color: string;
  label: string;
  centerPrimary: string;
  centerSecondary: string;
}) {
  const size = 108;
  const stroke = 10;
  const radius = (size - stroke) / 2;
  const circumference = 2 * Math.PI * radius;
  const clamped = Math.max(0, Math.min(max, value));
  const progress = max > 0 ? clamped / max : 0;
  const dash = circumference * progress;

  return (
    <div className={styles.personMetricDonut}>
      <div className={styles.personMetricDonutChart} aria-hidden>
        <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`}>
          <circle
            cx={size / 2}
            cy={size / 2}
            r={radius}
            fill="none"
            stroke={SCORE_TRACK}
            strokeWidth={stroke}
          />
          <circle
            cx={size / 2}
            cy={size / 2}
            r={radius}
            fill="none"
            stroke={color}
            strokeWidth={stroke}
            strokeLinecap="round"
            strokeDasharray={`${dash} ${circumference - dash}`}
            transform={`rotate(-90 ${size / 2} ${size / 2})`}
          />
        </svg>
        <div className={styles.personMetricDonutCenter}>
          <span className={styles.personMetricDonutValue}>{centerPrimary}</span>
          {centerSecondary ? (
            <span className={styles.personMetricDonutHint}>{centerSecondary}</span>
          ) : null}
        </div>
      </div>
      <p className={styles.personMetricDonutLabel}>{label}</p>
    </div>
  );
}

function temperatureFill(temperature: string | null): {
  value: number;
  color: string;
  primary: string;
  secondary: string;
} {
  switch (temperature) {
    case "Hot":
      return {
        value: 100,
        color: TEMP_COLORS.Hot,
        primary: "Hot",
        secondary: "Ready",
      };
    case "Warm":
      return {
        value: 62,
        color: TEMP_COLORS.Warm,
        primary: "Warm",
        secondary: "Nurture",
      };
    case "Cold":
      return {
        value: 28,
        color: TEMP_COLORS.Cold,
        primary: "Cold",
        secondary: "Long-term",
      };
    default:
      return {
        value: 0,
        color: TEMP_COLORS.empty,
        primary: "—",
        secondary: "",
      };
  }
}

export function PersonScoreTemperatureCard({
  contactId,
  score: initialScore,
  temperature: initialTemperature,
}: {
  contactId: string;
  score: number | null;
  temperature: string | null;
}) {
  const fields = useLiveQualification(contactId, {
    intent: null,
    targetLocation: null,
    propertyType: null,
    budget: null,
    timeline: null,
    financingStatus: null,
    mustHaves: null,
    motivation: null,
    preferences: null,
    aiSummary: null,
    score: initialScore,
    temperature: initialTemperature,
  });

  const score = fields.score;
  const scoreValue = score ?? 0;
  const scorePrimary = score != null ? String(score) : "—";
  const temp = temperatureFill(fields.temperature);

  return (
    <section className={styles.personSideCard}>
      <div className={styles.personSideCardHeaderStatic}>
        <span>Score &amp; Temperature</span>
      </div>
      <div className={styles.personMetricDonuts}>
        <Donut
          value={scoreValue}
          max={100}
          color={SCORE_FILL}
          label="Score"
          centerPrimary={scorePrimary}
          centerSecondary={score != null ? "of 100" : ""}
        />
        <Donut
          value={temp.value}
          max={100}
          color={temp.color}
          label="Temperature"
          centerPrimary={temp.primary}
          centerSecondary={temp.secondary}
        />
      </div>
    </section>
  );
}
