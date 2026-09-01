export const OPPORTUNITY_PIPELINES = [
  { value: "Intake", label: "Intake" },
] as const;

export type OpportunityPipeline = (typeof OPPORTUNITY_PIPELINES)[number]["value"];

export const DEFAULT_OPPORTUNITY_PIPELINE: OpportunityPipeline = "Intake";

export const INTAKE_STAGE_OPTIONS = [
  { value: "New", label: "New" },
  { value: "AI_Qualifying", label: "AI Qualifying" },
  { value: "Qualified", label: "Qualified" },
  { value: "Nurture", label: "Nurture" },
  { value: "Appointment_Set", label: "Appointment Set" },
  { value: "Closed_Won", label: "Closed Won" },
] as const;

export type IntakeStage = (typeof INTAKE_STAGE_OPTIONS)[number]["value"];

/** All known opportunity stages across pipelines (Intake for now). */
export type OpportunityStage = IntakeStage;

export const OPPORTUNITY_STAGE_OPTIONS = INTAKE_STAGE_OPTIONS;

export const OPPORTUNITY_STAGE_VALUES = OPPORTUNITY_STAGE_OPTIONS.map(
  (option) => option.value,
);

export const DEFAULT_OPPORTUNITY_STAGE: OpportunityStage = "New";

export function isOpportunityPipeline(value: string): value is OpportunityPipeline {
  return OPPORTUNITY_PIPELINES.some((pipeline) => pipeline.value === value);
}

export function isOpportunityStage(value: string): value is OpportunityStage {
  return OPPORTUNITY_STAGE_VALUES.includes(value as OpportunityStage);
}

export function formatOpportunityStageLabel(stage: string): string {
  const match = OPPORTUNITY_STAGE_OPTIONS.find((option) => option.value === stage);
  if (match) return match.label;
  return stage
    .split("_")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

export function stagesForPipeline(
  pipeline: OpportunityPipeline = DEFAULT_OPPORTUNITY_PIPELINE,
): readonly { value: OpportunityStage; label: string }[] {
  if (pipeline === "Intake") return INTAKE_STAGE_OPTIONS;
  return INTAKE_STAGE_OPTIONS;
}

export function defaultStageForPipeline(
  pipeline: OpportunityPipeline = DEFAULT_OPPORTUNITY_PIPELINE,
): OpportunityStage {
  return stagesForPipeline(pipeline)[0]?.value ?? DEFAULT_OPPORTUNITY_STAGE;
}

export function isOpportunityStageForPipeline(
  stage: string,
  pipeline: OpportunityPipeline,
): stage is OpportunityStage {
  return stagesForPipeline(pipeline).some((option) => option.value === stage);
}

export function normalizeOpportunityStage(raw: string): OpportunityStage {
  const trimmed = raw.trim();
  if (!trimmed) return DEFAULT_OPPORTUNITY_STAGE;
  if (isOpportunityStage(trimmed)) return trimmed;

  const compact = trimmed.toLowerCase().replace(/[\s-]+/g, "_");
  const aliases: Record<string, OpportunityStage> = {
    new: "New",
    ai_qualifying: "AI_Qualifying",
    aiqualifying: "AI_Qualifying",
    qualifying: "AI_Qualifying",
    qualification: "New",
    qualified: "Qualified",
    appointment_set: "Appointment_Set",
    appointmentset: "Appointment_Set",
    appointment: "Appointment_Set",
    nurture: "Nurture",
    proposal: "AI_Qualifying",
    negotiation: "Qualified",
    closed_won: "Closed_Won",
    closedwon: "Closed_Won",
    won: "Closed_Won",
    closed_lost: "Nurture",
    closedlost: "Nurture",
    lost: "Nurture",
  };

  return aliases[compact] ?? DEFAULT_OPPORTUNITY_STAGE;
}
