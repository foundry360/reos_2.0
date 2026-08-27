import { slugify } from "@/lib/admin/slug";
import { getSupabaseAdmin } from "@/lib/supabase/admin";

export interface GhlOpportunityWonInput {
  opportunityId: string;
  contactId?: string;
  locationId?: string;
  name: string;
  slug?: string;
  principalFirstName: string;
  principalLastName: string;
  email?: string;
  phone?: string;
  stripeCustomerId?: string;
  timezone?: string;
  website?: string;
  street?: string;
  city?: string;
  state?: string;
  postalCode?: string;
  country?: string;
}

export interface GhlProvisionResult {
  ok: true;
  tenantId: string;
  created: boolean;
  slug: string;
}

export interface GhlProvisionError {
  ok: false;
  error: string;
  status: number;
}

export type ParseGhlOpportunityWonResult = GhlOpportunityWonInput | GhlProvisionError;

export function isGhlProvisionError(value: ParseGhlOpportunityWonResult): value is GhlProvisionError {
  return "ok" in value && value.ok === false;
}

function asTrimmedString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function pickString(record: Record<string, unknown>, ...keys: string[]): string | undefined {
  for (const key of keys) {
    const value = asTrimmedString(record[key]);
    if (value) return value;
  }
  return undefined;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

export function parseGhlOpportunityWonPayload(body: unknown): ParseGhlOpportunityWonResult {
  const root = asRecord(body);
  if (!root) {
    return { ok: false, error: "Request body must be a JSON object.", status: 400 };
  }

  const contact = asRecord(root.contact) ?? asRecord(root.Contact) ?? {};
  const opportunity = asRecord(root.opportunity) ?? asRecord(root.Opportunity) ?? {};

  const opportunityId =
    pickString(root, "opportunityId", "opportunity_id", "opportunityID", "id") ??
    pickString(opportunity, "id", "opportunityId", "opportunity_id");

  const contactId =
    pickString(root, "contactId", "contact_id", "contactID") ??
    pickString(contact, "id", "contactId", "contact_id");

  const locationId =
    pickString(root, "locationId", "location_id", "locationID") ??
    pickString(opportunity, "locationId", "location_id") ??
    pickString(contact, "locationId", "location_id");

  const principalFirstName =
    pickString(root, "principalFirstName", "principal_first_name", "firstName", "first_name") ??
    pickString(contact, "firstName", "first_name", "firstNameLowerCase");

  const principalLastName =
    pickString(root, "principalLastName", "principal_last_name", "lastName", "last_name") ??
    pickString(contact, "lastName", "last_name", "lastNameLowerCase");

  const name =
    pickString(root, "name", "accountName", "account_name", "companyName", "company_name", "businessName", "business_name") ??
    pickString(opportunity, "name", "title", "opportunity_name", "opportunityName") ??
    pickString(contact, "companyName", "company_name", "businessName", "business_name");

  if (!opportunityId) {
    return { ok: false, error: "opportunityId (or opportunity_id) is required.", status: 400 };
  }

  if (!name) {
    return { ok: false, error: "Account name is required.", status: 400 };
  }

  if (!principalFirstName || !principalLastName) {
    return {
      ok: false,
      error: "Principal first and last name are required.",
      status: 400,
    };
  }

  return {
    opportunityId,
    contactId,
    locationId,
    name,
    slug: pickString(root, "slug"),
    principalFirstName,
    principalLastName,
    email: pickString(root, "email") ?? pickString(contact, "email"),
    phone: pickString(root, "phone", "phoneE164", "phone_e164") ?? pickString(contact, "phone"),
    stripeCustomerId:
      pickString(root, "stripeCustomerId", "stripe_customer_id", "stripeCustomerID") ??
      pickString(contact, "stripeCustomerId", "stripe_customer_id"),
    timezone: pickString(root, "timezone", "timeZone", "time_zone"),
    website: pickString(root, "website") ?? pickString(contact, "website"),
    street: pickString(root, "street", "address1", "address") ?? pickString(contact, "address1", "address"),
    city: pickString(root, "city") ?? pickString(contact, "city"),
    state: pickString(root, "state") ?? pickString(contact, "state"),
    postalCode:
      pickString(root, "postalCode", "postal_code", "zip", "zipCode", "zip_code") ??
      pickString(contact, "postalCode", "postal_code", "zip", "zipCode", "zip_code"),
    country: pickString(root, "country") ?? pickString(contact, "country"),
  };
}

async function ensureUniqueSlug(admin: NonNullable<ReturnType<typeof getSupabaseAdmin>>, baseSlug: string) {
  let slug = baseSlug;
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const { data } = await admin.from("tenants").select("id").eq("slug", slug).maybeSingle();
    if (!data) return slug;
    slug = `${baseSlug}-${attempt + 2}`;
  }
  return `${baseSlug}-${Date.now().toString(36)}`;
}

export async function provisionTenantFromGhlOpportunityWon(
  input: GhlOpportunityWonInput,
): Promise<GhlProvisionResult | GhlProvisionError> {
  const admin = getSupabaseAdmin();
  if (!admin) {
    return { ok: false, error: "Database is not configured.", status: 503 };
  }

  const { data: existing } = await admin
    .from("tenants")
    .select("id, slug")
    .eq("ghl_opportunity_id", input.opportunityId)
    .maybeSingle();

  if (existing) {
    return {
      ok: true,
      tenantId: existing.id,
      created: false,
      slug: existing.slug,
    };
  }

  const baseSlug = slugify(input.slug?.trim() || input.name);
  if (!baseSlug) {
    return { ok: false, error: "Could not derive a valid account slug.", status: 400 };
  }

  const slug = await ensureUniqueSlug(admin, baseSlug);

  const { data: tenant, error } = await admin
    .from("tenants")
    .insert({
      name: input.name.trim(),
      slug,
      principal_first_name: input.principalFirstName.trim(),
      principal_last_name: input.principalLastName.trim(),
      timezone: input.timezone?.trim() || "America/New_York",
      status: "company_info",
      account_type: "Tenant",
      source: "ghl",
      ghl_opportunity_id: input.opportunityId,
      ghl_contact_id: input.contactId ?? null,
      ghl_location_id: input.locationId ?? null,
      email: input.email ?? null,
      website: input.website ?? null,
      street: input.street ?? null,
      city: input.city ?? null,
      state: input.state ?? null,
      postal_code: input.postalCode ?? null,
      country: input.country ?? "United States",
      stripe_customer_id: input.stripeCustomerId ?? null,
      internal_notes: "Provisioned from GHL Closed Won webhook.",
    })
    .select("id, slug")
    .single();

  if (error || !tenant) {
    if (error?.code === "23505") {
      const { data: raced } = await admin
        .from("tenants")
        .select("id, slug")
        .eq("ghl_opportunity_id", input.opportunityId)
        .maybeSingle();
      if (raced) {
        return {
          ok: true,
          tenantId: raced.id,
          created: false,
          slug: raced.slug,
        };
      }
    }
    return { ok: false, error: error?.message ?? "Failed to create tenant.", status: 500 };
  }

  return {
    ok: true,
    tenantId: tenant.id,
    created: true,
    slug: tenant.slug,
  };
}

export function getGhlOpportunityWonWebhookUrl(origin: string): string {
  return `${origin.replace(/\/$/, "")}/api/webhooks/ghl/opportunity-won`;
}
