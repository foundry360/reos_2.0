"use server";

import { revalidatePath } from "next/cache";
import { isLeadStatus } from "@/lib/leads/lead-status";
import {
  DEFAULT_OPPORTUNITY_PIPELINE,
  normalizeOpportunityStage,
} from "@/lib/opportunities/opportunity-stages";
import { parsePhoneForStorage } from "@/lib/phone-display";
import { resolveCurrentTenant } from "@/lib/tenant/current-tenant";
import { createClient } from "@/lib/supabase/server";
import { splitFullName, type ImportEntity, type ImportMode } from "@/lib/crm/import-parse";

const MAX_IMPORT_ROWS = 500;

export interface ImportRowPayload {
  values: Record<string, string>;
}

export interface ImportCrmResult {
  ok: boolean;
  error?: string;
  created: number;
  updated: number;
  skipped: number;
  failed: number;
  errors: string[];
}

function normalizeKey(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, " ");
}

function normalizeLeadStatus(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return "New";
  if (isLeadStatus(trimmed)) return trimmed;

  const compact = trimmed.toLowerCase().replace(/[\s-]+/g, "_");
  const aliases: Record<string, string> = {
    new: "New",
    working: "Working",
    contacted: "Contacted",
    qualified: "Qualified",
    converted: "Converted",
    // legacy imports
    qualifying: "New",
    ready_to_book: "Working",
    readytobook: "Working",
    nurture: "Contacted",
    nurturing: "Contacted",
    booked: "Qualified",
    handoff: "Working",
    compliance: "New",
  };
  return aliases[compact] ?? "New";
}

function parseAmountCents(raw: string): number | null | { error: string } {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const normalized = trimmed.replace(/[$,]/g, "");
  const amount = Number(normalized);
  if (!Number.isFinite(amount) || amount < 0) {
    return { error: "Invalid amount" };
  }
  // Accept either dollars or already-cents-looking integers under 1000 as dollars
  if (amount >= 1000 && Number.isInteger(amount) && !trimmed.includes(".")) {
    // Heuristic: large whole numbers without decimals are dollars
    return Math.round(amount * 100);
  }
  return Math.round(amount * 100);
}

function parseCloseDate(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const iso = trimmed.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (iso) return trimmed;
  const parsed = new Date(trimmed);
  if (Number.isNaN(parsed.getTime())) return null;
  return parsed.toISOString().slice(0, 10);
}

function resolveLeadNames(values: Record<string, string>): {
  firstName: string;
  lastName: string;
} {
  const full = values.full_name?.trim() ?? "";
  let firstName = values.first_name?.trim() ?? "";
  let lastName = values.last_name?.trim() ?? "";
  if (full && !firstName && !lastName) {
    const split = splitFullName(full);
    firstName = split.firstName;
    lastName = split.lastName;
  } else if (full && !firstName) {
    firstName = full;
  }
  return { firstName, lastName };
}

export async function importCrmRowsAction(input: {
  entity: ImportEntity;
  mode: ImportMode;
  rows: ImportRowPayload[];
}): Promise<ImportCrmResult> {
  const empty: ImportCrmResult = {
    ok: false,
    created: 0,
    updated: 0,
    skipped: 0,
    failed: 0,
    errors: [],
  };

  const { tenantId } = await resolveCurrentTenant();
  if (!tenantId) {
    return { ...empty, error: "Your account is not linked to a workspace yet." };
  }

  if (!Array.isArray(input.rows) || input.rows.length === 0) {
    return { ...empty, error: "No rows to import." };
  }
  if (input.rows.length > MAX_IMPORT_ROWS) {
    return {
      ...empty,
      error: `Imports are limited to ${MAX_IMPORT_ROWS} rows. Split the file and try again.`,
    };
  }

  const supabase = await createClient();
  const result: ImportCrmResult = {
    ok: true,
    created: 0,
    updated: 0,
    skipped: 0,
    failed: 0,
    errors: [],
  };

  if (input.entity === "leads" || input.entity === "contacts") {
    const kind = input.entity === "contacts" ? "contact" : "lead";
    await importLeads(supabase, tenantId, input.mode, input.rows, result, kind);
    revalidatePath(kind === "contact" ? "/contacts" : "/leads");
  } else {
    await importOpportunities(supabase, tenantId, input.mode, input.rows, result);
    revalidatePath("/opportunities");
  }

  if (result.failed > 0 && result.created === 0 && result.updated === 0) {
    result.ok = false;
    result.error = result.errors[0] ?? "Import failed.";
  }

  return result;
}

async function findLeadByPhone(
  supabase: Awaited<ReturnType<typeof createClient>>,
  tenantId: string,
  phone: string,
  kind: "lead" | "contact",
): Promise<string | null> {
  const digits = phone.replace(/\D/g, "");
  const { data: identities } = await supabase
    .from("contact_identities")
    .select("contact_id")
    .eq("channel", "sms")
    .or(`external_id.eq.${digits},external_id.eq.${phone}`);

  const ids = (identities ?? []).map((row) => row.contact_id);
  if (ids.length === 0) return null;

  const { data: contact } = await supabase
    .from("contacts")
    .select("id")
    .eq("tenant_id", tenantId)
    .eq("record_type", kind)
    .in("id", ids)
    .limit(1)
    .maybeSingle();

  return contact?.id ?? null;
}

async function findLeadByName(
  supabase: Awaited<ReturnType<typeof createClient>>,
  tenantId: string,
  firstName: string,
  lastName: string,
  kind: "lead" | "contact",
): Promise<string | null> {
  if (!firstName && !lastName) return null;
  let query = supabase
    .from("contacts")
    .select("id, first_name, last_name")
    .eq("tenant_id", tenantId)
    .eq("record_type", kind);
  if (firstName) query = query.ilike("first_name", firstName);
  if (lastName) query = query.ilike("last_name", lastName);
  const { data } = await query.limit(5);
  const match = (data ?? []).find(
    (row) =>
      normalizeKey(row.first_name ?? "") === normalizeKey(firstName) &&
      normalizeKey(row.last_name ?? "") === normalizeKey(lastName),
  );
  return match?.id ?? null;
}

async function importLeads(
  supabase: Awaited<ReturnType<typeof createClient>>,
  tenantId: string,
  mode: ImportMode,
  rows: ImportRowPayload[],
  result: ImportCrmResult,
  kind: "lead" | "contact" = "lead",
) {
  for (let index = 0; index < rows.length; index += 1) {
    const values = rows[index]?.values ?? {};
    const { firstName, lastName } = resolveLeadNames(values);
    const status = normalizeLeadStatus(values.status ?? "");
    const email = (values.email ?? "").trim().toLowerCase();
    const phoneResult = parsePhoneForStorage(values.phone ?? "");

    if (!phoneResult.ok) {
      result.failed += 1;
      result.errors.push(`Row ${index + 1}: ${phoneResult.error}`);
      continue;
    }

    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      result.failed += 1;
      result.errors.push(`Row ${index + 1}: Invalid email address.`);
      continue;
    }

    if (!firstName && !lastName && !phoneResult.phone && !email) {
      result.failed += 1;
      result.errors.push(`Row ${index + 1}: Enter a name, email, or phone number.`);
      continue;
    }

    let existingId: string | null = null;
    if (phoneResult.phone) {
      existingId = await findLeadByPhone(supabase, tenantId, phoneResult.phone, kind);
    }
    if (!existingId && email) {
      const { data: byEmail } = await supabase
        .from("contacts")
        .select("id")
        .eq("tenant_id", tenantId)
        .eq("record_type", kind)
        .ilike("email", email)
        .limit(1)
        .maybeSingle();
      existingId = byEmail?.id ?? null;
    }
    if (!existingId) {
      existingId = await findLeadByName(supabase, tenantId, firstName, lastName, kind);
    }

    try {
      if (existingId) {
        if (mode === "add_only") {
          result.skipped += 1;
          continue;
        }

        const { error } = await supabase
          .from("contacts")
          .update({
            first_name: firstName || null,
            last_name: lastName || null,
            email: email || null,
            lead_status: status,
          })
          .eq("id", existingId)
          .eq("tenant_id", tenantId);

        if (error) {
          result.failed += 1;
          result.errors.push(`Row ${index + 1}: ${error.message}`);
          continue;
        }

        if (phoneResult.phone) {
          const digits = phoneResult.phone.replace(/\D/g, "");
          const { data: existingIdentity } = await supabase
            .from("contact_identities")
            .select("id")
            .eq("contact_id", existingId)
            .eq("channel", "sms")
            .maybeSingle();

          if (existingIdentity) {
            await supabase
              .from("contact_identities")
              .update({ external_id: digits })
              .eq("id", existingIdentity.id);
          } else {
            await supabase.from("contact_identities").insert({
              contact_id: existingId,
              channel: "sms",
              external_id: digits,
            });
          }
        }

        result.updated += 1;
        continue;
      }

      if (mode === "update_only") {
        result.skipped += 1;
        continue;
      }

      const { data: contact, error } = await supabase
        .from("contacts")
        .insert({
          tenant_id: tenantId,
          first_name: firstName || null,
          last_name: lastName || null,
          email: email || null,
          lead_status: status,
          record_type: kind,
        })
        .select("id")
        .single();

      if (error || !contact) {
        result.failed += 1;
        result.errors.push(`Row ${index + 1}: ${error?.message ?? "Could not create lead."}`);
        continue;
      }

      if (phoneResult.phone) {
        const digits = phoneResult.phone.replace(/\D/g, "");
        const { error: identityError } = await supabase.from("contact_identities").insert({
          contact_id: contact.id,
          channel: "sms",
          external_id: digits,
        });
        if (identityError) {
          await supabase.from("contacts").delete().eq("id", contact.id);
          result.failed += 1;
          result.errors.push(
            `Row ${index + 1}: ${
              identityError.code === "23505"
                ? "A lead with this phone number already exists."
                : identityError.message
            }`,
          );
          continue;
        }
      }

      result.created += 1;
    } catch (error) {
      result.failed += 1;
      result.errors.push(
        `Row ${index + 1}: ${error instanceof Error ? error.message : "Unexpected error."}`,
      );
    }
  }
}

async function findOpportunityByName(
  supabase: Awaited<ReturnType<typeof createClient>>,
  tenantId: string,
  name: string,
): Promise<string | null> {
  const { data } = await supabase
    .from("opportunities")
    .select("id, name")
    .eq("tenant_id", tenantId)
    .ilike("name", name)
    .limit(5);

  const match = (data ?? []).find((row) => normalizeKey(row.name) === normalizeKey(name));
  return match?.id ?? null;
}

async function findContactIdByLeadName(
  supabase: Awaited<ReturnType<typeof createClient>>,
  tenantId: string,
  leadName: string,
): Promise<string | null> {
  const { firstName, lastName } = splitFullName(leadName);
  return (
    (await findLeadByName(supabase, tenantId, firstName, lastName, "lead")) ??
    (await findLeadByName(supabase, tenantId, firstName, lastName, "contact"))
  );
}

async function importOpportunities(
  supabase: Awaited<ReturnType<typeof createClient>>,
  tenantId: string,
  mode: ImportMode,
  rows: ImportRowPayload[],
  result: ImportCrmResult,
) {
  for (let index = 0; index < rows.length; index += 1) {
    const values = rows[index]?.values ?? {};
    const name = values.name?.trim() ?? "";
    if (!name) {
      result.failed += 1;
      result.errors.push(`Row ${index + 1}: Opportunity name is required.`);
      continue;
    }

    const stage = normalizeOpportunityStage(values.stage ?? "");
    const amount = parseAmountCents(values.amount ?? "");
    if (amount && typeof amount === "object" && "error" in amount) {
      result.failed += 1;
      result.errors.push(`Row ${index + 1}: ${amount.error}`);
      continue;
    }

    const expectedCloseDate = parseCloseDate(values.close_date ?? "");
    const notes = values.notes?.trim() || null;
    const leadName = values.lead_name?.trim() ?? "";
    const contactId = leadName
      ? await findContactIdByLeadName(supabase, tenantId, leadName)
      : null;

    const existingId = await findOpportunityByName(supabase, tenantId, name);
    const payload = {
      name,
      pipeline: DEFAULT_OPPORTUNITY_PIPELINE,
      stage,
      amount_cents: typeof amount === "number" ? amount : null,
      expected_close_date: expectedCloseDate,
      notes,
      contact_id: contactId,
    };

    try {
      if (existingId) {
        if (mode === "add_only") {
          result.skipped += 1;
          continue;
        }
        const { error } = await supabase
          .from("opportunities")
          .update(payload)
          .eq("id", existingId)
          .eq("tenant_id", tenantId);
        if (error) {
          result.failed += 1;
          result.errors.push(`Row ${index + 1}: ${error.message}`);
          continue;
        }
        result.updated += 1;
        continue;
      }

      if (mode === "update_only") {
        result.skipped += 1;
        continue;
      }

      const { error } = await supabase.from("opportunities").insert({
        tenant_id: tenantId,
        ...payload,
      });
      if (error) {
        result.failed += 1;
        result.errors.push(`Row ${index + 1}: ${error.message}`);
        continue;
      }
      result.created += 1;
    } catch (error) {
      result.failed += 1;
      result.errors.push(
        `Row ${index + 1}: ${error instanceof Error ? error.message : "Unexpected error."}`,
      );
    }
  }
}
