export const USAGE_CATEGORIES = [
  "twilio_sms",
  "twilio_number",
  "ai_tokens",
  "other",
] as const;

export type UsageCategory = (typeof USAGE_CATEGORIES)[number];

export const USAGE_CATEGORY_LABELS: Record<UsageCategory, string> = {
  twilio_sms: "Twilio SMS",
  twilio_number: "Phone numbers",
  ai_tokens: "AI usage",
  other: "Other",
};
