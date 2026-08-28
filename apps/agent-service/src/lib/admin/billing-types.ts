export interface BillingTenantRow {
  id: string;
  name: string;
  slug: string;
  status: string;
  stripeCustomerId: string | null;
  cycleUsageCents: number;
  href: string;
}

export interface BillingTenantOption {
  id: string;
  name: string;
  slug: string;
}
