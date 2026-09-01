export const OPPORTUNITY_TYPE_OPTIONS = [
  { value: "Buyer", label: "Buyer" },
  { value: "Seller", label: "Seller" },
  { value: "Buyer_Seller", label: "Buyer / Seller" },
  { value: "Lease", label: "Lease" },
  { value: "Investment", label: "Investment" },
  { value: "Referral", label: "Referral" },
  { value: "Other", label: "Other" },
] as const;

export type OpportunityType = (typeof OPPORTUNITY_TYPE_OPTIONS)[number]["value"];

export const DEFAULT_OPPORTUNITY_TYPE: OpportunityType = "Buyer";

export const OPPORTUNITY_PRIORITY_OPTIONS = [
  { value: "Low", label: "Low" },
  { value: "Medium", label: "Medium" },
  { value: "High", label: "High" },
  { value: "Urgent", label: "Urgent" },
] as const;

export type OpportunityPriority = (typeof OPPORTUNITY_PRIORITY_OPTIONS)[number]["value"];

export const OPPORTUNITY_PRIORITY_COLORS: Record<OpportunityPriority, string> = {
  Low: "#55A9DB",
  Medium: "#16B298",
  High: "#16B29B",
  Urgent: "#FA8F59",
};

export const OPPORTUNITY_LEAD_SOURCE_OPTIONS = [
  { value: "Website", label: "Website" },
  { value: "Referral", label: "Referral" },
  { value: "Zillow", label: "Zillow" },
  { value: "Realtor_com", label: "Realtor.com" },
  { value: "Open_House", label: "Open house" },
  { value: "Social", label: "Social" },
  { value: "Paid_Ads", label: "Paid ads" },
  { value: "Walk_In", label: "Walk-in" },
  { value: "Other", label: "Other" },
] as const;

export type OpportunityLeadSource = (typeof OPPORTUNITY_LEAD_SOURCE_OPTIONS)[number]["value"];

export function isOpportunityType(value: string): value is OpportunityType {
  return OPPORTUNITY_TYPE_OPTIONS.some((option) => option.value === value);
}

export function isOpportunityPriority(value: string): value is OpportunityPriority {
  return OPPORTUNITY_PRIORITY_OPTIONS.some((option) => option.value === value);
}

export function isOpportunityLeadSource(value: string): value is OpportunityLeadSource {
  return OPPORTUNITY_LEAD_SOURCE_OPTIONS.some((option) => option.value === value);
}
