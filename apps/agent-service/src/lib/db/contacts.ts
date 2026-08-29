import type { ContactContext, LeadStatus } from "@/lib/coordinator";
import { getSupabaseAdmin } from "@/lib/supabase/admin";

export interface InboundChannel {
  channel: "sms" | "messenger" | "instagram";
  from: string;
  to?: string;
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

  return byAccount?.tenant_id ?? null;
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
    .select(
      "contact_id, contacts!inner(id, tenant_id, first_name, lead_status, ai_summary, opted_out)",
    )
    .eq("channel", channel)
    .eq("external_id", lookupId)
    .maybeSingle();

  if (error || !identity) return null;

  type Row = {
    contact_id: string;
    contacts: {
      id: string;
      tenant_id: string;
      first_name: string | null;
      lead_status: string;
      ai_summary: string | null;
      opted_out: boolean;
    };
  };

  const row = identity as unknown as Row;
  if (row.contacts.tenant_id !== tenantId) return null;

  const c = row.contacts;
  return {
    contactId: c.id,
    accountId: c.tenant_id,
    phone: externalId,
    firstName: c.first_name ?? undefined,
    leadStatus: c.lead_status as LeadStatus,
    optedOut: c.opted_out,
    aiSummary: c.ai_summary ?? undefined,
  };
}

async function intakeContact(
  tenantId: string,
  channel: InboundChannel["channel"],
  externalId: string,
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

  const { data: contact, error: contactError } = await db
    .from("contacts")
    .insert({ tenant_id: tenantId, lead_status: "New" })
    .select("id, tenant_id, first_name, lead_status, ai_summary, opted_out")
    .single();

  if (contactError || !contact) {
    console.error("Intake contact error:", contactError);
    return null;
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

  return {
    contactId: contact.id,
    accountId: contact.tenant_id,
    phone: externalId,
    firstName: contact.first_name ?? undefined,
    leadStatus: contact.lead_status as LeadStatus,
    optedOut: contact.opted_out,
    aiSummary: contact.ai_summary ?? undefined,
  };
}

/** Resolve tenant + contact for an inbound message. Creates contact on first touch (Intake). */
export async function resolveInboundContact(
  inbound: InboundChannel,
): Promise<ContactContext> {
  const tenantId =
    inbound.channel === "sms"
      ? await resolveTenantByToNumber(inbound.to)
      : await resolveTenantByMetaRecipient(inbound.channel, inbound.to);

  if (!tenantId) return stubContext(inbound.from);

  const existing = await findIdentityContact(
    tenantId,
    inbound.channel,
    inbound.from,
  );
  if (existing) return existing;

  const created = await intakeContact(tenantId, inbound.channel, inbound.from);
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

export async function appendMessage(params: {
  tenantId: string;
  contactId: string;
  channel: string;
  direction: "inbound" | "outbound";
  body: string;
  playbook?: string;
}): Promise<void> {
  const db = getSupabaseAdmin();
  if (!db) return;

  await db.from("messages").insert({
    tenant_id: params.tenantId,
    contact_id: params.contactId,
    channel: params.channel,
    direction: params.direction,
    body: params.body,
    playbook: params.playbook ?? null,
  });
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
