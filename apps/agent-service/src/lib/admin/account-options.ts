export const ACCOUNT_TYPES = [
  "Tenant",
  "Customer",
  "Prospect",
  "Partner",
] as const;

export const ACCOUNT_INDUSTRIES = [
  "Real Estate",
  "Residential Real Estate",
  "Commercial Real Estate",
  "Property Management",
  "Mortgage",
  "Insurance",
  "Other",
] as const;

export type AccountType = (typeof ACCOUNT_TYPES)[number];
export type AccountIndustry = (typeof ACCOUNT_INDUSTRIES)[number];
