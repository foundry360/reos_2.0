import { createClient } from "@/lib/supabase/server";
import { requirePlatformAdmin } from "@/lib/admin/auth";
import { getPlatformAdminLabel, getUserDisplayLabel } from "@/lib/admin/platform-admin-actions";
import { tenantStripeUsageReady } from "@/lib/admin/tenant-stripe";

export interface TenantAgentConfig {
  conciergeEnabled: boolean;
  schedulerEnabled: boolean;
  followUpEnabled: boolean;
  intakeEnabled: boolean;
  researcherEnabled: boolean;
  scoutEnabled: boolean;
  complianceStrict: boolean;
  quietHoursStart: string | null;
  quietHoursEnd: string | null;
}

export interface TenantChannelStatus {
  channel: "messenger" | "instagram" | "email" | "calendar";
  status: "connected" | "disconnected" | "error";
  accountLabel: string | null;
  externalPageId: string | null;
  awaitingPageSelection: boolean;
}

export interface TenantContact {
  id: string;
  firstName: string;
  lastName: string;
  email: string | null;
  phoneE164: string | null;
  website: string | null;
  title: string | null;
}

export interface TenantConfig {
  id: string;
  name: string;
  slug: string;
  status: string;
  timezone: string;
  principalFirstName: string | null;
  principalLastName: string | null;
  accountType: string | null;
  website: string | null;
  industry: string | null;
  accountOwnerId: string | null;
  accountOwnerLabel: string | null;
  email: string | null;
  street: string | null;
  city: string | null;
  state: string | null;
  postalCode: string | null;
  country: string | null;
  stripeCustomerId: string | null;
  stripeBillingReady: boolean;
  internalNotes: string | null;
  createdAt: string;
  updatedAt: string;
  createdById: string | null;
  createdByLabel: string | null;
  lastModifiedById: string | null;
  lastModifiedByLabel: string | null;
  primaryPhone: string | null;
  contacts: TenantContact[];
  channelAccounts: TenantChannelStatus[];
  agents: TenantAgentConfig;
}

export async function getTenantConfig(tenantId: string): Promise<TenantConfig | null> {
  await requirePlatformAdmin();
  const supabase = await createClient();

  const { data: tenant } = await supabase
    .from("tenants")
    .select(
      "id, name, slug, status, timezone, principal_first_name, principal_last_name, account_type, website, industry, account_owner_id, email, street, city, state, postal_code, country, stripe_customer_id, internal_notes, created_at, updated_at, created_by_id, last_modified_by_id",
    )
    .eq("id", tenantId)
    .maybeSingle();

  if (!tenant) return null;

  const [{ data: phones }, { data: agents }, contactsResult, channelsResult] = await Promise.all([
    supabase
      .from("tenant_phone_numbers")
      .select("phone_e164, is_primary")
      .eq("tenant_id", tenantId),
    supabase
      .from("tenant_agents")
      .select(
        "concierge_enabled, scheduler_enabled, follow_up_enabled, intake_enabled, researcher_enabled, scout_enabled, compliance_strict, quiet_hours_start, quiet_hours_end",
      )
      .eq("tenant_id", tenantId)
      .maybeSingle(),
    supabase
      .from("tenant_contacts")
      .select("id, first_name, last_name, email, phone_e164, website, title")
      .eq("tenant_id", tenantId)
      .order("created_at", { ascending: true }),
    supabase
      .from("channel_accounts")
      .select("channel, status, external_page_id, external_account_id, metadata")
      .eq("tenant_id", tenantId),
  ]);

  const additionalContacts =
    contactsResult.error || !contactsResult.data
      ? []
      : contactsResult.data.map((contact) => ({
          id: contact.id,
          firstName: contact.first_name,
          lastName: contact.last_name,
          email: contact.email,
          phoneE164: contact.phone_e164,
          website: contact.website,
          title: contact.title,
        }));

  const primaryPhone = phones?.find((phone) => phone.is_primary)?.phone_e164 ?? null;

  const channelAccounts: TenantChannelStatus[] = (
    ["email", "calendar", "messenger", "instagram"] as const
  ).map(
    (channel) => {
      const row = channelsResult.data?.find((entry) => entry.channel === channel);
      const metadata = row?.metadata as {
        label?: string;
        awaiting_page_selection?: boolean;
      } | null;
      const externalPageId = row?.external_page_id?.trim() || null;
      const status = (row?.status as TenantChannelStatus["status"]) ?? "disconnected";
      const awaitingPageSelection =
        (channel === "messenger" || channel === "instagram") &&
        status === "connected" &&
        (!externalPageId || metadata?.awaiting_page_selection === true);
      const accountLabel =
        metadata?.label?.trim() ||
        row?.external_account_id?.trim() ||
        null;

      return {
        channel,
        status,
        accountLabel,
        externalPageId,
        awaitingPageSelection,
      };
    },
  );

  const [accountOwnerLabel, createdByLabel, lastModifiedByLabel, stripeBillingReady] =
    await Promise.all([
    getPlatformAdminLabel(tenant.account_owner_id),
    getUserDisplayLabel(tenant.created_by_id ?? tenant.account_owner_id),
    getUserDisplayLabel(tenant.last_modified_by_id),
    tenant.stripe_customer_id
      ? tenantStripeUsageReady(tenant.stripe_customer_id)
      : Promise.resolve(false),
  ]);

  return {
    id: tenant.id,
    name: tenant.name,
    slug: tenant.slug,
    status: tenant.status,
    timezone: tenant.timezone,
    principalFirstName: tenant.principal_first_name,
    principalLastName: tenant.principal_last_name,
    accountType: tenant.account_type,
    website: tenant.website,
    industry: tenant.industry,
    accountOwnerId: tenant.account_owner_id,
    accountOwnerLabel,
    email: tenant.email,
    street: tenant.street,
    city: tenant.city,
    state: tenant.state,
    postalCode: tenant.postal_code,
    country: tenant.country,
    stripeCustomerId: tenant.stripe_customer_id,
    stripeBillingReady,
    internalNotes: tenant.internal_notes,
    createdAt: tenant.created_at,
    updatedAt: tenant.updated_at,
    createdById: tenant.created_by_id,
    createdByLabel,
    lastModifiedById: tenant.last_modified_by_id,
    lastModifiedByLabel,
    primaryPhone,
    contacts: additionalContacts,
    channelAccounts,
    agents: {
      conciergeEnabled: agents?.concierge_enabled ?? true,
      schedulerEnabled: agents?.scheduler_enabled ?? true,
      followUpEnabled: agents?.follow_up_enabled ?? true,
      intakeEnabled: agents?.intake_enabled ?? true,
      researcherEnabled: agents?.researcher_enabled ?? false,
      scoutEnabled: agents?.scout_enabled ?? false,
      complianceStrict: agents?.compliance_strict ?? true,
      quietHoursStart: agents?.quiet_hours_start ?? null,
      quietHoursEnd: agents?.quiet_hours_end ?? null,
    },
  };
}
