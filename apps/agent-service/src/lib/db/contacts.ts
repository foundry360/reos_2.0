import type {
  ContactContext,
  LeadIntent,
  LeadStatus,
  LeadTemperature,
} from "@/lib/coordinator";
import { notifyTenantNewLead } from "@/lib/notifications/create-notification";
import { getSupabaseAdmin } from "@/lib/supabase/admin";

export interface InboundChannel {
  channel: "sms" | "messenger" | "instagram";
  from: string;
  to?: string;
}

const CONTACT_SELECT =
  "id, tenant_id, first_name, last_name, email, lead_status, lead_temperature, ai_summary, agent_brief, recommended_next_action, qualification_score, intent, ready_to_book, appt_booked, handoff, opted_out, target_location, property_type, budget, timeline, financing_status, must_haves, motivation, preferences";

type ContactRow = {
  id: string;
  tenant_id: string;
  first_name: string | null;
  last_name?: string | null;
  email?: string | null;
  lead_status: string;
  lead_temperature: string | null;
  ai_summary: string | null;
  agent_brief: string | null;
  recommended_next_action: string | null;
  qualification_score: number | null;
  intent: string | null;
  ready_to_book: boolean;
  appt_booked: boolean;
  handoff: boolean;
  opted_out: boolean;
  target_location?: string | null;
  property_type?: string | null;
  budget?: string | null;
  timeline?: string | null;
  financing_status?: string | null;
  must_haves?: string | null;
  motivation?: string | null;
  preferences?: string | null;
};

function toContactContext(
  c: ContactRow,
  externalId: string,
): ContactContext {
  return {
    contactId: c.id,
    accountId: c.tenant_id,
    phone: externalId,
    firstName: c.first_name ?? undefined,
    lastName: c.last_name ?? undefined,
    email: c.email ?? undefined,
    leadStatus: c.lead_status as LeadStatus,
    leadTemperature: (c.lead_temperature as LeadTemperature | null) ?? null,
    readyToBook: c.ready_to_book ?? false,
    apptBooked: c.appt_booked ?? false,
    handoff: c.handoff ?? false,
    optedOut: c.opted_out,
    intent: (c.intent as LeadIntent | null) ?? null,
    aiSummary: c.ai_summary ?? undefined,
    agentBrief: c.agent_brief ?? undefined,
    recommendedNextAction: c.recommended_next_action ?? undefined,
    qualificationScore: c.qualification_score,
    targetLocation: c.target_location ?? undefined,
    propertyType: c.property_type ?? undefined,
    budget: c.budget ?? undefined,
    timeline: c.timeline ?? undefined,
    financingStatus: c.financing_status ?? undefined,
    mustHaves: c.must_haves ?? undefined,
    motivation: c.motivation ?? undefined,
    preferences: c.preferences ?? undefined,
  };
}

function normalizePhone(value: string): string {
  const digits = value.replace(/\D/g, "");
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
  if (digits.length === 10) return `+1${digits}`;
  if (value.startsWith("+")) return value;
  return digits.length > 0 ? `+${digits}` : value;
}

function phoneLookupKey(value: string): string {
  const digits = value.replace(/\D/g, "");
  return digits.slice(-10);
}

function stubContext(from: string, tenantId?: string): ContactContext {
  return {
    phone: from,
    accountId: tenantId ?? "default-tenant",
    leadStatus: "New",
    readyToBook: false,
    apptBooked: false,
    handoff: false,
    optedOut: false,
  };
}

async function resolveTenantByToNumber(to?: string): Promise<string | null> {
  if (!to) return null;
  const db = getSupabaseAdmin();
  if (!db) return null;

  const normalized = normalizePhone(to);
  const { data } = await db
    .from("tenant_phone_numbers")
    .select("tenant_id")
    .eq("phone_e164", normalized)
    .maybeSingle();

  return data?.tenant_id ?? null;
}

async function resolveTenantByMetaRecipient(
  channel: "messenger" | "instagram",
  recipientId?: string,
): Promise<string | null> {
  if (!recipientId) return null;
  const db = getSupabaseAdmin();
  if (!db) return null;

  const { data: byPage } = await db
    .from("channel_accounts")
    .select("tenant_id")
    .eq("channel", channel)
    .eq("status", "connected")
    .eq("external_page_id", recipientId)
    .maybeSingle();

  if (byPage?.tenant_id) return byPage.tenant_id;

  const { data: byAccount } = await db
    .from("channel_accounts")
    .select("tenant_id")
    .eq("channel", channel)
    .eq("status", "connected")
    .eq("external_account_id", recipientId)
    .maybeSingle();

  if (byAccount?.tenant_id) return byAccount.tenant_id;

  // Instagram webhooks use the IG professional account id as entry.id. Graph often
  // omits that id at connect time, so backfill from the first inbound webhook when
  // exactly one Instagram channel is waiting for it.
  if (channel === "instagram") {
    const { data: pending } = await db
      .from("channel_accounts")
      .select("id, tenant_id, metadata")
      .eq("channel", "instagram")
      .eq("status", "connected")
      .is("external_account_id", null);

    if (pending?.length === 1) {
      const row = pending[0];
      const metadata = {
        ...((row.metadata as Record<string, unknown> | null) ?? {}),
        instagram_business_account_id: recipientId,
      };
      await db
        .from("channel_accounts")
        .update({
          external_account_id: recipientId,
          metadata,
        })
        .eq("id", row.id);
      return row.tenant_id;
    }
  }

  return null;
}

export async function resolveInboundTenantId(
  inbound: InboundChannel,
): Promise<string | null> {
  if (inbound.channel === "sms") {
    return resolveTenantByToNumber(inbound.to);
  }
  return resolveTenantByMetaRecipient(inbound.channel, inbound.to);
}

async function findIdentityContact(
  tenantId: string,
  channel: InboundChannel["channel"],
  externalId: string,
): Promise<ContactContext | null> {
  const db = getSupabaseAdmin();
  if (!db) return null;

  const lookupId =
    channel === "sms" ? phoneLookupKey(externalId) : externalId;

  const { data: identity, error } = await db
    .from("contact_identities")
    .select(`contact_id, contacts!inner(${CONTACT_SELECT})`)
    .eq("channel", channel)
    .eq("external_id", lookupId)
    .maybeSingle();

  if (error || !identity) return null;

  type Row = {
    contact_id: string;
    contacts: ContactRow;
  };

  const row = identity as unknown as Row;
  if (row.contacts.tenant_id !== tenantId) return null;

  return toContactContext(row.contacts, externalId);
}

async function intakeContact(
  tenantId: string,
  channel: InboundChannel["channel"],
  externalId: string,
  profile?: {
    firstName?: string | null;
    lastName?: string | null;
    avatarUrl?: string | null;
  },
): Promise<ContactContext | null> {
  const db = getSupabaseAdmin();
  if (!db) return null;

  const { data: agents } = await db
    .from("tenant_agents")
    .select("intake_enabled")
    .eq("tenant_id", tenantId)
    .maybeSingle();

  if (agents && !agents.intake_enabled) return null;

  const identityKey =
    channel === "sms" ? phoneLookupKey(externalId) : externalId;

  const firstName = profile?.firstName?.trim() || null;
  const lastName = profile?.lastName?.trim() || null;
  const avatarUrl = profile?.avatarUrl?.trim() || null;

  const { data: contact, error: contactError } = await db
    .from("contacts")
    .insert({
      tenant_id: tenantId,
      lead_status: "New",
      record_type: "lead",
      ...(firstName ? { first_name: firstName } : {}),
      ...(lastName ? { last_name: lastName } : {}),
    })
    .select(CONTACT_SELECT)
    .single();

  if (contactError || !contact) {
    console.error("Intake contact error:", contactError);
    return null;
  }

  if (avatarUrl) {
    const { error: avatarError } = await db
      .from("contacts")
      .update({ avatar_url: avatarUrl })
      .eq("id", contact.id);
    if (avatarError) {
      console.warn("Intake avatar save skipped:", avatarError.message);
    }
  }

  const { error: identityError } = await db.from("contact_identities").insert({
    contact_id: contact.id,
    channel,
    external_id: identityKey,
  });

  if (identityError) {
    console.error("Intake identity error:", identityError);
    return null;
  }

  await notifyTenantNewLead({
    tenantId,
    contactId: contact.id,
    firstName: contact.first_name ?? firstName,
    lastName,
    channel,
  });

  return toContactContext(contact as ContactRow, externalId);
}

/** Resolve tenant + contact for an inbound message. Creates contact on first touch (Intake). */
export async function resolveInboundContact(
  inbound: InboundChannel,
  profile?: {
    firstName?: string | null;
    lastName?: string | null;
    avatarUrl?: string | null;
  },
  options?: { createIfMissing?: boolean },
): Promise<ContactContext> {
  const tenantId = await resolveInboundTenantId(inbound);

  if (!tenantId) return stubContext(inbound.from);

  const existing = await findIdentityContact(
    tenantId,
    inbound.channel,
    inbound.from,
  );
  if (existing) return existing;

  if (options?.createIfMissing === false) {
    return stubContext(inbound.from, tenantId);
  }

  const created = await intakeContact(
    tenantId,
    inbound.channel,
    inbound.from,
    profile,
  );
  if (created) return created;

  return stubContext(inbound.from, tenantId);
}

export async function updateContactFields(
  contactId: string,
  fields: Record<string, string | number | boolean | null>,
): Promise<boolean> {
  const db = getSupabaseAdmin();
  if (!db) return false;

  const { error } = await db.from("contacts").update(fields).eq("id", contactId);
  if (error) {
    console.error("Update contact error:", error);
    return false;
  }
  return true;
}

/** Link or refresh an SMS identity when Concierge collects a phone number. */
export async function upsertContactSmsIdentity(
  contactId: string,
  phoneRaw: string,
): Promise<boolean> {
  const db = getSupabaseAdmin();
  if (!db) return false;

  const lookupId = phoneLookupKey(phoneRaw);
  if (lookupId.length < 10) return false;

  const { data: existing } = await db
    .from("contact_identities")
    .select("id, contact_id")
    .eq("channel", "sms")
    .eq("external_id", lookupId)
    .maybeSingle();

  if (existing) {
    if (existing.contact_id === contactId) return true;
    console.warn(
      "SMS identity already linked to another contact; skipping phone upsert",
      lookupId,
    );
    return false;
  }

  const { data: ownSms } = await db
    .from("contact_identities")
    .select("id")
    .eq("contact_id", contactId)
    .eq("channel", "sms")
    .maybeSingle();

  if (ownSms) {
    const { error } = await db
      .from("contact_identities")
      .update({ external_id: lookupId })
      .eq("id", ownSms.id);
    if (error) {
      console.error("Update SMS identity error:", error);
      return false;
    }
    return true;
  }

  const { error } = await db.from("contact_identities").insert({
    contact_id: contactId,
    channel: "sms",
    external_id: lookupId,
  });
  if (error) {
    console.error("Insert SMS identity error:", error);
    return false;
  }
  return true;
}

export async function appendMessage(params: {
  tenantId: string;
  contactId: string;
  channel: string;
  direction: "inbound" | "outbound";
  body: string;
  playbook?: string;
}): Promise<string | null> {
  const db = getSupabaseAdmin();
  if (!db) return null;

  const { data, error } = await db
    .from("messages")
    .insert({
      tenant_id: params.tenantId,
      contact_id: params.contactId,
      channel: params.channel,
      direction: params.direction,
      body: params.body,
      playbook: params.playbook ?? null,
    })
    .select("id")
    .single();

  if (error) {
    console.error("Append message error:", error);
    return null;
  }
  return data?.id ?? null;
}

export async function getRecentMessages(
  contactId: string,
  limit = 20,
): Promise<Array<{ role: "user" | "assistant"; content: string }>> {
  const db = getSupabaseAdmin();
  if (!db) return [];

  const { data } = await db
    .from("messages")
    .select("direction, body")
    .eq("contact_id", contactId)
    .order("created_at", { ascending: true })
    .limit(limit);

  if (!data) return [];

  return data.map((m) => ({
    role: m.direction === "inbound" ? ("user" as const) : ("assistant" as const),
    content: m.body,
  }));
}

/** @deprecated Use resolveInboundContact */
export async function findContactByPhone(
  phone: string,
  tenantAccountId?: string,
): Promise<ContactContext> {
  return resolveInboundContact({
    channel: "sms",
    from: phone,
    to: tenantAccountId,
  });
}
