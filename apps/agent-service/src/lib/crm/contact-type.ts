export const CONTACT_TYPE_OPTIONS = [
  { value: "Prospect", label: "Prospect" },
  { value: "Customer", label: "Customer" },
  { value: "Inactive Customer", label: "Inactive Customer" },
  { value: "Partner", label: "Partner" },
  { value: "Vendor", label: "Vendor" },
] as const;

export type ContactType = (typeof CONTACT_TYPE_OPTIONS)[number]["value"];

export const CONTACT_TYPE_VALUES = CONTACT_TYPE_OPTIONS.map((option) => option.value);

export const DEFAULT_CONTACT_TYPE: ContactType = "Prospect";

export function isContactType(value: string): value is ContactType {
  return CONTACT_TYPE_VALUES.includes(value as ContactType);
}

export function formatContactTypeLabel(value: string | null | undefined): string {
  if (!value) return "—";
  const match = CONTACT_TYPE_OPTIONS.find((option) => option.value === value);
  return match?.label ?? value;
}
