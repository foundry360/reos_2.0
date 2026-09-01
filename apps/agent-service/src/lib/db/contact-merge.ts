import { getSupabaseAdmin } from "@/lib/supabase/admin";

const MERGE_SELECT =
  "id, tenant_id, first_name, last_name, email, lead_status, lead_temperature, ai_summary, agent_brief, recommended_next_action, qualification_score, intent, ready_to_book, appt_booked, handoff, opted_out, record_type, contact_type, target_location, property_type, budget, timeline, financing_status, must_haves, motivation, preferences, created_at";

type MergeContactRow = {
  id: string;
  tenant_id: string;
  first_name: string | null;
  last_name: string | null;
  email: string | null;
  lead_status: string | null;
  lead_temperature: string | null;
  ai_summary: string | null;
  agent_brief: string | null;
  recommended_next_action: string | null;
  qualification_score: number | null;
  intent: string | null;
  ready_to_book: boolean | null;
  appt_booked: boolean | null;
  handoff: boolean | null;
  opted_out: boolean | null;
  record_type: string | null;
  contact_type: string | null;
  target_location: string | null;
  property_type: string | null;
  budget: string | null;
  timeline: string | null;
  financing_status: string | null;
  must_haves: string | null;
  motivation: string | null;
  preferences: string | null;
  created_at: string;
};

const FILLABLE_STRINGS = [
  "first_name",
  "last_name",
  "email",
  "ai_summary",
  "agent_brief",
  "recommended_next_action",
  "intent",
  "target_location",
  "property_type",
  "budget",
  "timeline",
  "financing_status",
  "must_haves",
  "motivation",
  "preferences",
  "lead_temperature",
  "contact_type",
] as const;

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

function phoneLookupKey(value: string): string {
  const digits = value.replace(/\D/g, "");
  return digits.slice(-10);
}

function filledFieldCount(row: MergeContactRow): number {
  let n = 0;
  for (const key of FILLABLE_STRINGS) {
    const v = row[key];
    if (typeof v === "string" && v.trim()) n += 1;
  }
  if (row.qualification_score != null) n += 1;
  if (row.appt_booked) n += 2;
  if (row.record_type === "contact") n += 1;
  return n;
}

/** Pick the surviving contact when two records represent the same person. */
export function pickCanonicalContact(
  a: MergeContactRow,
  b: MergeContactRow,
): { winner: MergeContactRow; loser: MergeContactRow } {
  const rank = (row: MergeContactRow) => {
    let score = 0;
    if (row.appt_booked) score += 1000;
    if (row.record_type === "contact") score += 500;
    if (row.contact_type === "Prospect") score += 50;
    score += filledFieldCount(row) * 10;
    // Older wins ties → slightly prefer earlier created_at
    const created = Date.parse(row.created_at) || 0;
    score += Math.max(0, 1_000_000_000_000 - created) / 1e12;
    return score;
  };
  return rank(a) >= rank(b) ? { winner: a, loser: b } : { winner: b, loser: a };
}

export async function findContactByEmail(
  tenantId: string,
  email: string,
  excludeContactId?: string,
): Promise<MergeContactRow | null> {
  const db = getSupabaseAdmin();
  if (!db) return null;
  const normalized = normalizeEmail(email);
  if (!normalized.includes("@")) return null;

  let query = db
    .from("contacts")
    .select(MERGE_SELECT)
    .eq("tenant_id", tenantId)
    .ilike("email", normalized)
    .order("created_at", { ascending: true })
    .limit(5);

  if (excludeContactId) {
    query = query.neq("id", excludeContactId);
  }

  const { data, error } = await query;
  if (error) {
    console.error("findContactByEmail failed:", error);
    return null;
  }
  return (data?.[0] as MergeContactRow | undefined) ?? null;
}

export async function findContactBySmsPhone(
  tenantId: string,
  phoneRaw: string,
  excludeContactId?: string,
): Promise<MergeContactRow | null> {
  const db = getSupabaseAdmin();
  if (!db) return null;
  const lookupId = phoneLookupKey(phoneRaw);
  if (lookupId.length < 10) return null;

  const { data: identity, error } = await db
    .from("contact_identities")
    .select("contact_id")
    .eq("channel", "sms")
    .eq("external_id", lookupId)
    .maybeSingle();

  if (error || !identity?.contact_id) {
    if (error) console.error("findContactBySmsPhone identity lookup:", error);
    return null;
  }
  if (excludeContactId && identity.contact_id === excludeContactId) {
    return null;
  }

  const { data: contact, error: contactError } = await db
    .from("contacts")
    .select(MERGE_SELECT)
    .eq("id", identity.contact_id)
    .eq("tenant_id", tenantId)
    .maybeSingle();

  if (contactError || !contact) {
    if (contactError) console.error("findContactBySmsPhone contact:", contactError);
    return null;
  }
  return contact as MergeContactRow;
}

async function loadContact(contactId: string): Promise<MergeContactRow | null> {
  const db = getSupabaseAdmin();
  if (!db) return null;
  const { data, error } = await db
    .from("contacts")
    .select(MERGE_SELECT)
    .eq("id", contactId)
    .maybeSingle();
  if (error || !data) {
    if (error) console.error("loadContact for merge failed:", error);
    return null;
  }
  return data as MergeContactRow;
}

/**
 * Move identities + related rows from loser onto winner, fill empty CRM fields,
 * then delete the loser contact.
 */
export async function mergeContacts(
  winnerId: string,
  loserId: string,
): Promise<string | null> {
  if (winnerId === loserId) return winnerId;
  const db = getSupabaseAdmin();
  if (!db) return null;

  const [winner, loser] = await Promise.all([
    loadContact(winnerId),
    loadContact(loserId),
  ]);
  if (!winner || !loser) return winnerId;
  if (winner.tenant_id !== loser.tenant_id) {
    console.error("mergeContacts refused: tenant mismatch", winnerId, loserId);
    return winnerId;
  }

  // Move identities (skip channel+external_id already on winner).
  const { data: loserIdentities } = await db
    .from("contact_identities")
    .select("id, channel, external_id")
    .eq("contact_id", loserId);

  for (const identity of loserIdentities ?? []) {
    const { data: existing } = await db
      .from("contact_identities")
      .select("id")
      .eq("channel", identity.channel)
      .eq("external_id", identity.external_id)
      .maybeSingle();

    if (existing?.id) {
      if (existing.id !== identity.id) {
        await db.from("contact_identities").delete().eq("id", identity.id);
      }
      continue;
    }

    const { error } = await db
      .from("contact_identities")
      .update({ contact_id: winnerId })
      .eq("id", identity.id);
    if (error) {
      console.error("mergeContacts identity move failed:", error);
      await db.from("contact_identities").delete().eq("id", identity.id);
    }
  }

  // Re-point dependent rows.
  for (const table of [
    "messages",
    "opportunities",
    "tasks",
    "contact_activities",
  ] as const) {
    const { error } = await db
      .from(table)
      .update({ contact_id: winnerId })
      .eq("contact_id", loserId);
    if (error) {
      console.error(`mergeContacts ${table} reassign failed:`, error.message);
    }
  }

  // Fill empty winner fields from loser.
  const patch: Record<string, string | number | boolean | null> = {};
  for (const key of FILLABLE_STRINGS) {
    const w = winner[key];
    const l = loser[key];
    const winnerEmpty = w == null || (typeof w === "string" && !w.trim());
    const loserHas = typeof l === "string" && l.trim().length > 0;
    if (winnerEmpty && loserHas) patch[key] = l;
  }
  if (winner.qualification_score == null && loser.qualification_score != null) {
    patch.qualification_score = loser.qualification_score;
  }
  if (!winner.appt_booked && loser.appt_booked) {
    patch.appt_booked = true;
    patch.ready_to_book = false;
    patch.lead_status = "Converted";
    patch.record_type = "contact";
    if (!winner.contact_type) patch.contact_type = "Prospect";
  }
  if (winner.record_type !== "contact" && loser.record_type === "contact") {
    patch.record_type = "contact";
    if (!winner.contact_type && loser.contact_type) {
      patch.contact_type = loser.contact_type;
    }
  }
  if (Object.keys(patch).length > 0) {
    const { error } = await db.from("contacts").update(patch).eq("id", winnerId);
    if (error) console.error("mergeContacts field merge failed:", error);
  }

  const { error: deleteError } = await db
    .from("contacts")
    .delete()
    .eq("id", loserId);
  if (deleteError) {
    console.error("mergeContacts delete loser failed:", deleteError);
  } else {
    console.log("mergeContacts merged", loserId, "into", winnerId);
  }

  return winnerId;
}

/**
 * If email/phone matches another tenant contact, merge into the canonical record.
 * Returns the surviving contact id (may differ from contactId).
 */
export async function reconcileContactByEmailOrPhone(
  contactId: string,
  options?: { email?: string | null; phone?: string | null },
): Promise<string> {
  const db = getSupabaseAdmin();
  if (!db) return contactId;

  let currentId = contactId;

  for (let attempt = 0; attempt < 5; attempt++) {
    const self = await loadContact(currentId);
    if (!self) return currentId;

    const email =
      (options?.email ? normalizeEmail(options.email) : null) ||
      (self.email ? normalizeEmail(self.email) : null);
    const phone = options?.phone?.trim() || null;

    const matches: MergeContactRow[] = [];

    if (email) {
      const byEmail = await findContactByEmail(self.tenant_id, email, currentId);
      if (byEmail) matches.push(byEmail);
    }

    if (phone) {
      const byPhone = await findContactBySmsPhone(
        self.tenant_id,
        phone,
        currentId,
      );
      if (byPhone && !matches.some((m) => m.id === byPhone.id)) {
        matches.push(byPhone);
      }
    }

    if (matches.length === 0) return currentId;

    let winnerRow = self;
    let winnerId = currentId;

    for (const other of matches) {
      const { winner, loser } = pickCanonicalContact(winnerRow, other);
      const merged = await mergeContacts(winner.id, loser.id);
      winnerId = merged ?? winner.id;
      winnerRow = (await loadContact(winnerId)) ?? winner;
      if (!winnerRow) return winnerId;
    }

    currentId = winnerId;
  }

  return currentId;
}
