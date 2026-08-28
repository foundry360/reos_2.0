import type { LeadStatus } from "@/lib/coordinator";

export const LEAD_STATUS_OPTIONS = [
  { value: "New", label: "New" },
  { value: "Working", label: "Working" },
  { value: "Contacted", label: "Contacted" },
  { value: "Qualified", label: "Qualified" },
  { value: "Converted", label: "Converted" },
] as const satisfies readonly { value: LeadStatus; label: string }[];

export const LEAD_STATUS_VALUES = LEAD_STATUS_OPTIONS.map((option) => option.value);

export function isLeadStatus(value: string): value is LeadStatus {
  return LEAD_STATUS_VALUES.includes(value as LeadStatus);
}

export function formatLeadStatusLabel(status: string): string {
  const match = LEAD_STATUS_OPTIONS.find((option) => option.value === status);
  if (match) return match.label;
  return status
    .split("_")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

export function formatLeadTemperatureLabel(temp: string | null | undefined): string {
  if (!temp) return "—";
  return temp;
}
