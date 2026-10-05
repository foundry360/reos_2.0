import type {
  ContactContext,
  LeadIntent,
  LeadStatus,
  LeadTemperature,
} from "@/lib/coordinator";
import { computeQualificationScore } from "@/lib/crm/qualification-score";
import { notifyTenantNewLead } from "@/lib/notifications/create-notification";
import { mergeContacts, reconcileContactByEmailOrPhone } from "@/lib/db/contact-merge";
import { logSystemContactActivity } from "@/lib/crm/log-system-activity";
import {
  ensureAppointmentSetOpportunity,
  syncIntakeOpportunityStage,
} from "@/lib/opportunities/create-from-booking";
import { getSupabaseAdmin } from "@/lib/supabase/admin";
import { emitJourneyEvent } from "@/lib/journeys/emit-journey-event";
import { withStatusOrigin, type StatusOriginContext } from "@/lib/crm/status-origin";

export interface InboundChannel {
  channel: "sms" | "messenger" | "instagram";
  from: string;
  to?: string;
}

export type CommentIdentityChannel = "facebook_comment" | "instagram_comment";
type IdentityChannel = InboundChannel["channel"] | CommentIdentityChannel;

function notificationChannel(channel: IdentityChannel): InboundChannel["channel"] {
  if (channel === "facebook_comment") return "messenger";
  if (channel === "instagram_comment") return "instagram";
  return channel;
}

const CONTACT_SELECT =
  "id, tenant_id, first_name, last_name, email, lead_status, lead_temperature, ai_summary, agent_brief, recommended_next_action, qualification_score, intent, ready_to_book, appt_booked, handoff, opted_out, target_location, property_type, budget, timeline, financing_status, must_haves, motivation, preferences, assigned_agent_id";

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
  assigned_agent_id?: string | null;
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

/** CRM forms store SMS identities as full E.164 digits (1XXXXXXXXXX); intake stores the last 10. */
function smsIdentityVariants(value: string): string[] {
  const key = phoneLookupKey(value);
  return [key, `1${key}`];
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
  channel: IdentityChannel,
  externalId: string,
): Promise<ContactContext | null> {
  const db = getSupabaseAdmin();
  if (!db) return null;

  const lookupIds =
    channel === "sms" ? smsIdentityVariants(externalId) : [externalId];

  const { data: identities, error } = await db
    .from("contact_identities")
    .select(`contact_id, contacts!inner(${CONTACT_SELECT})`)
    .eq("channel", channel)
    .in("external_id", lookupIds)
    .eq("contacts.tenant_id", tenantId)
    .limit(1);

  if (error || !identities?.length) return null;

  type Row = {
    contact_id: string;
    contacts: ContactRow;
  };

  const row = identities[0] as unknown as Row;
  return toContactContext(row.contacts, externalId);
}

async function intakeContact(
  tenantId: string,
  channel: IdentityChannel,
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
      // First touch stays a Lead; promoted to Prospect Account when qualifying starts.
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
    channel: notificationChannel(channel),
  });

  await logSystemContactActivity({
    tenantId,
    contactId: contact.id,
    activityType: "contact",
    title: "New lead",
    body: [firstName, lastName].filter(Boolean).join(" ") || notificationChannel(channel),
    relatedEntityType: "lead",
    relatedEntityId: contact.id,
  });

  // New Intake opportunity when the lead engages (stays a Lead until consult booked).
  await syncIntakeOpportunityStage(contact.id);

  emitJourneyEvent({
    tenantId,
    type: "lead.created",
    sourceId: contact.id,
    contactId: contact.id,
    entityType: "contact",
    entityId: contact.id,
    payload: {
      channel: notificationChannel(channel),
      source: channel.endsWith("_comment") ? "comment" : "message",
    },
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

async function insertIdentity(
  contactId: string,
  channel: IdentityChannel,
  externalId: string,
): Promise<void> {
  const db = getSupabaseAdmin();
  if (!db) return;
  const { error } = await db.from("contact_identities").insert({
    contact_id: contactId,
    channel,
    external_id: externalId,
  });
  if (error && error.code !== "23505") {
    console.error("Insert identity error:", error);
  }
}

/**
 * Find or create the contact behind a post comment. Checks the comment identity first,
 * then a DM identity with the same id (Instagram commonly reuses the IGSID).
 */
export async function resolveCommentContact(input: {
  tenantId: string;
  identityChannel: CommentIdentityChannel;
  dmChannel: "messenger" | "instagram";
  commenterId: string;
  profile?: { firstName?: string | null; lastName?: string | null };
}): Promise<{ ctx: ContactContext; created: boolean } | null> {
  const byComment = await findIdentityContact(
    input.tenantId,
    input.identityChannel,
    input.commenterId,
  );
  if (byComment) return { ctx: byComment, created: false };

  const byDm = await findIdentityContact(input.tenantId, input.dmChannel, input.commenterId);
  if (byDm?.contactId) {
    await insertIdentity(byDm.contactId, input.identityChannel, input.commenterId);
    return { ctx: byDm, created: false };
  }

  const created = await intakeContact(
    input.tenantId,
    input.identityChannel,
    input.commenterId,
    input.profile,
  );
  return created ? { ctx: created, created: true } : null;
}

/**
 * Attach a DM identity (PSID / IGSID) to a contact. When it already belongs to another
 * contact in the same tenant, the two records are merged. Returns the surviving id.
 */
export async function linkContactDmIdentity(input: {
  tenantId: string;
  contactId: string;
  channel: "messenger" | "instagram";
  externalId: string;
}): Promise<string> {
  const db = getSupabaseAdmin();
  if (!db) return input.contactId;

  const { data: existing } = await db
    .from("contact_identities")
    .select("contact_id, contacts!inner(tenant_id)")
    .eq("channel", input.channel)
    .eq("external_id", input.externalId)
    .maybeSingle();

  if (!existing) {
    await insertIdentity(input.contactId, input.channel, input.externalId);
    return input.contactId;
  }

  if (existing.contact_id === input.contactId) return input.contactId;

  const owner = existing.contacts as unknown as { tenant_id: string } | { tenant_id: string }[];
  const ownerTenantId = Array.isArray(owner) ? owner[0]?.tenant_id : owner?.tenant_id;
  if (ownerTenantId !== input.tenantId) return input.contactId;

  // The DM thread's contact wins so the existing conversation stays intact.
  return (await mergeContacts(existing.contact_id, input.contactId)) ?? input.contactId;
}

export async function updateContactFields(
  contactId: string,
  fields: Record<string, string | number | boolean | null>,
  origin?: StatusOriginContext,
): Promise<boolean> {
  const db = getSupabaseAdmin();
  if (!db) return false;

  const query = db.from("contacts").update(fields).eq("id", contactId);
  const { error } = await (origin ? withStatusOrigin(query, origin) : query);
  if (error) {
    console.error("Update contact error:", error);
    return false;
  }
  return true;
}

type SummarySource = {
  first_name?: string | null;
  intent?: string | null;
  target_location?: string | null;
  property_type?: string | null;
  budget?: string | null;
  timeline?: string | null;
  financing_status?: string | null;
  must_haves?: string | null;
  motivation?: string | null;
  preferences?: string | null;
};

const INTENT_VERBS: Record<string, string> = {
  buyer: "buy",
  buy: "buy",
  buying: "buy",
  seller: "sell",
  sell: "sell",
  selling: "sell",
  investor: "invest in",
  invest: "invest in",
  renter: "rent",
  rent: "rent",
  tenant: "rent",
  "buyer & seller": "buy and sell",
  "buyer and seller": "buy and sell",
  both: "buy and sell",
};

const PROPERTY_NOUNS: Record<string, string> = {
  "single family": "single-family home",
  "single-family": "single-family home",
  sfh: "single-family home",
  condo: "condo",
  townhouse: "townhouse",
  townhome: "townhome",
  "multi family": "multi-family property",
  "multi-family": "multi-family property",
  land: "land",
  lot: "lot",
};

const lowerFirst = (s: string) => (/^[A-Z][a-z]/.test(s) ? s[0].toLowerCase() + s.slice(1) : s);
const sentence = (s: string) => {
  const t = s.trim().replace(/\s+/g, " ");
  return /[.!?]$/.test(t) ? t : `${t}.`;
};

function budgetPhrase(budget: string): string {
  const b = lowerFirst(budget);
  return /^(under|up to|below|less than|around|about|between|over|above|max)/i.test(b)
    ? `with a budget ${b}`
    : `with a budget of ${b}`;
}

function financingSentence(financing: string): string {
  const f = financing.toLowerCase();
  if (/\bcash\b/.test(f)) return "They plan to pay cash.";
  if (/pre-?approved|pre-?qualified/.test(f)) return `They are ${f}.`;
  if (/^not\b|^no\b/.test(f)) return `Financing: ${f}.`;
  return `Financing: ${lowerFirst(financing)}.`;
}

/** Plain-language summary built from CRM fields (no model call). */
export function buildAiSummaryFromFields(row: SummarySource): string | null {
  const v = (s?: string | null) => s?.trim() || "";
  const name = v(row.first_name);
  const intent = v(row.intent);
  const type = v(row.property_type);
  const location = v(row.target_location);
  const budget = v(row.budget);

  const sentences: string[] = [];

  if (intent || type || location || budget) {
    const verb = INTENT_VERBS[intent.toLowerCase()];
    const noun = type ? PROPERTY_NOUNS[type.toLowerCase()] ?? type.toLowerCase() : "";
    let lead: string;
    const object = noun ? `a ${noun}` : verb?.startsWith("sell") ? "their home" : "a property";
    if (verb) lead = `looking to ${verb} ${object}`;
    else if (intent) lead = `a ${intent.toLowerCase()}${noun ? ` interested in a ${noun}` : ""}`;
    else lead = `interested in ${noun ? `a ${noun}` : "a property"}`;
    if (location) lead += ` in ${location}`;
    if (budget) lead += ` ${budgetPhrase(budget)}`;
    sentences.push(sentence(name ? `${name} is ${lead}` : lead[0].toUpperCase() + lead.slice(1)));
  }

  const timeline = v(row.timeline);
  if (timeline) {
    const t = lowerFirst(timeline).replace(/\b(Days?|Weeks?|Months?|Years?)\b/g, (m) => m.toLowerCase());
    sentences.push(
      /^(asap|immediately|now|right away)/i.test(t)
        ? `They want to move ${t}.`
        : /^\d/.test(t)
          ? `Their timeline is ${t}.`
          : `Timeline: ${t}.`,
    );
  }

  const financing = v(row.financing_status);
  if (financing) sentences.push(financingSentence(financing));

  const mustHaves = v(row.must_haves);
  if (mustHaves) sentences.push(sentence(`Must-haves: ${lowerFirst(mustHaves)}`));

  const motivation = v(row.motivation);
  if (motivation) sentences.push(sentence(`Motivation: ${lowerFirst(motivation)}`));

  const preferences = v(row.preferences);
  if (preferences) sentences.push(sentence(`Preferences: ${lowerFirst(preferences)}`));

  return sentences.length > 0 ? sentences.join(" ") : null;
}

/**
 * Keep ai_summary populated from qualification columns when the model skips it.
 * force=true rebuilds even if a summary already exists (use when model did not write one).
 */
export async function ensureAiSummary(
  contactId: string,
  options?: { force?: boolean },
): Promise<string | null> {
  const db = getSupabaseAdmin();
  if (!db) return null;

  const { data, error } = await db
    .from("contacts")
    .select(
      "ai_summary, first_name, intent, target_location, property_type, budget, timeline, financing_status, must_haves, motivation, preferences",
    )
    .eq("id", contactId)
    .maybeSingle();

  if (error || !data) {
    if (error) console.error("ensureAiSummary load failed:", error);
    return null;
  }

  const built = buildAiSummaryFromFields(data);
  if (!built) return data.ai_summary?.trim() || null;

  const existing = data.ai_summary?.trim() || "";
  if (!options?.force && existing) return existing;

  if (existing === built) return existing;

  const ok = await updateContactFields(contactId, { ai_summary: built });
  return ok ? built : existing || null;
}

/**
 * Keep qualification_score + lead_temperature filled from CRM fields.
 */
export async function ensureScoreAndTemperature(
  contactId: string,
  options?: { force?: boolean },
): Promise<{ score: number; temperature: string } | null> {
  const db = getSupabaseAdmin();
  if (!db) return null;

  const { data, error } = await db
    .from("contacts")
    .select(
      "qualification_score, lead_temperature, intent, target_location, property_type, budget, timeline, financing_status, must_haves, motivation, preferences, ai_summary, appt_booked, ready_to_book",
    )
    .eq("id", contactId)
    .maybeSingle();

  if (error || !data) {
    if (error) console.error("ensureScoreAndTemperature load failed:", error);
    return null;
  }

  const computed = computeQualificationScore(data);
  const hasScore =
    typeof data.qualification_score === "number" &&
    data.qualification_score >= 0;
  const hasTemp = Boolean(data.lead_temperature?.trim());

  if (!options?.force && hasScore && hasTemp) {
    await syncIntakeOpportunityStage(contactId);
    return {
      score: data.qualification_score as number,
      temperature: data.lead_temperature as string,
    };
  }

  if (
    hasScore &&
    hasTemp &&
    data.qualification_score === computed.score &&
    data.lead_temperature === computed.temperature
  ) {
    await syncIntakeOpportunityStage(contactId);
    return computed;
  }

  // Only write when we have enough signal to avoid scoring empty records as Cold/0.
  const hasSignal = Boolean(
    data.intent ||
      data.target_location ||
      data.property_type ||
      data.budget ||
      data.timeline ||
      data.financing_status ||
      data.appt_booked,
  );
  if (!hasSignal) return null;

  const ok = await updateContactFields(contactId, {
    qualification_score: computed.score,
    lead_temperature: computed.temperature,
  });
  if (ok) {
    await syncIntakeOpportunityStage(contactId);
  }
  return ok ? computed : null;
}

/**
 * After a consult is booked: mark appt, convert lead → Account (contact) as Prospect,
 * and persist invite email when provided. Merges duplicates that share the email.
 * Returns the surviving contact id (may differ after merge).
 */
export async function markConsultBooked(
  contactId: string,
  options?: { email?: string | null; skipAppointmentActivityLog?: boolean },
): Promise<string | null> {
  const fields: Record<string, string | number | boolean | null> = {
    appt_booked: true,
    ready_to_book: false,
    lead_status: "Converted",
    record_type: "contact",
    contact_type: "Prospect",
  };
  const email = options?.email?.trim().toLowerCase();
  if (email && email.includes("@")) {
    fields.email = email;
  }
  const ok = await updateContactFields(contactId, fields);
  if (!ok) return null;

  let survivorId = contactId;
  if (email) {
    survivorId = await reconcileContactByEmailOrPhone(contactId, { email });
  }

  await ensureAiSummary(survivorId, { force: false });
  await ensureScoreAndTemperature(survivorId, { force: true });
  await ensureAppointmentSetOpportunity(survivorId, {
    skipAppointmentActivityLog: options?.skipAppointmentActivityLog,
  });
  return survivorId;
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

  const { data: matches } = await db
    .from("contact_identities")
    .select("id, contact_id")
    .eq("channel", "sms")
    .in("external_id", smsIdentityVariants(phoneRaw))
    .limit(1);
  const existing = matches?.[0] ?? null;

  if (existing) {
    if (existing.contact_id === contactId) return true;
    // Same phone on another contact → merge, then identity lives on the winner.
    const survivor = await reconcileContactByEmailOrPhone(contactId, {
      phone: phoneRaw,
    });
    return survivor === contactId || survivor === existing.contact_id;
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
  contextLabel?: string | null;
}): Promise<string | null> {
  const db = getSupabaseAdmin();
  if (!db) return null;

  const row = {
    tenant_id: params.tenantId,
    contact_id: params.contactId,
    channel: params.channel,
    direction: params.direction,
    body: params.body,
    playbook: params.playbook ?? null,
  };
  const insert = (values: Record<string, unknown>) =>
    db.from("messages").insert(values).select("id").single();

  let { data, error } = await insert(
    params.contextLabel ? { ...row, context_label: params.contextLabel } : row,
  );
  // Before migration 050 is applied the column is missing; never lose the message over a label.
  if (error && params.contextLabel) {
    ({ data, error } = await insert(row));
  }

  if (error) {
    console.error("Append message error:", error);
    return null;
  }
  return data?.id ?? null;
}

export async function getRecentMessages(
  contactId: string,
  limit = 20,
): Promise<Array<{ role: "user" | "assistant"; content: string; createdAt?: string }>> {
  const db = getSupabaseAdmin();
  if (!db) return [];

  // Fetch newest N, then reverse so the model sees chronological order.
  const recent = (columns: string) =>
    db
      .from("messages")
      .select(columns)
      .eq("contact_id", contactId)
      .order("created_at", { ascending: false })
      .limit(limit)
      .returns<
        Array<{ direction: string; body: string; context_label?: string | null; created_at?: string }>
      >();

  // context_label arrives with migration 050; keep history working before it is applied.
  const withLabels = await recent("direction, body, context_label, created_at");
  const data = withLabels.error ? (await recent("direction, body, created_at")).data : withLabels.data;

  if (!data) return [];

  return data
    .slice()
    .reverse()
    .map((m) => ({
      role: m.direction === "inbound" ? ("user" as const) : ("assistant" as const),
      content: m.context_label ? `[${m.context_label}] ${m.body}` : m.body,
      createdAt: m.created_at,
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
