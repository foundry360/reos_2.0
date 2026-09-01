import { getSupabaseAdmin } from "@/lib/supabase/admin";
import {
  hasCoreQualificationFields,
  type ContactContext,
  type LeadIntent,
  type LeadStatus,
} from "@/lib/coordinator";
import {
  DEFAULT_OPPORTUNITY_PIPELINE,
  type OpportunityStage,
} from "@/lib/opportunities/opportunity-stages";
import {
  DEFAULT_OPPORTUNITY_TYPE,
  type OpportunityType,
} from "@/lib/opportunities/opportunity-fields";
import { formatOpportunityStageLabel } from "@/lib/opportunities/opportunity-stages";
import { parseBudgetToCents } from "@/lib/opportunities/parse-budget";
import { logSystemContactActivity } from "@/lib/crm/log-system-activity";

function opportunityTypeFromIntent(
  intent: string | null | undefined,
): OpportunityType {
  switch (intent) {
    case "Seller":
      return "Seller";
    case "Investor":
      return "Investment";
    case "Referral":
      return "Referral";
    case "Buyer":
      return "Buyer";
    default:
      return DEFAULT_OPPORTUNITY_TYPE;
  }
}

function personDisplayName(
  firstName: string | null | undefined,
  lastName: string | null | undefined,
): string {
  const name = [firstName?.trim(), lastName?.trim()].filter(Boolean).join(" ");
  return name || "Lead";
}

/** Pipeline order for forward moves; Nurture is a side path from Qualified. */
const STAGE_RANK: Record<string, number> = {
  New: 0,
  AI_Qualifying: 1,
  Qualified: 2,
  Appointment_Set: 3,
  Nurture: 1,
  Closed_Won: 99,
};

function stageRank(stage: string): number {
  return STAGE_RANK[stage] ?? 0;
}

function canAdvanceTo(current: string, target: OpportunityStage): boolean {
  if (current === target) return false;
  if (current === "Closed_Won") return false;
  // Never move backward from Appointment Set.
  if (current === "Appointment_Set" && target !== "Appointment_Set") {
    return false;
  }
  // Side path: scored Warm/Cold not booking → Nurture (only when core intake done).
  if (
    target === "Nurture" &&
    (current === "New" ||
      current === "AI_Qualifying" ||
      current === "Qualified")
  ) {
    return true;
  }
  // Still gathering after a premature Nurture → return to AI Qualifying.
  if (current === "Nurture" && target === "AI_Qualifying") {
    return true;
  }
  // Re-engage out of Nurture when they heat up, start booking, or book.
  if (
    current === "Nurture" &&
    (target === "Qualified" || target === "Appointment_Set")
  ) {
    return true;
  }
  return stageRank(target) > stageRank(current);
}

type ContactForIntake = {
  id: string;
  tenant_id: string;
  first_name: string | null;
  last_name: string | null;
  intent: string | null;
  appt_booked: boolean | null;
  ready_to_book: boolean | null;
  lead_status: string | null;
  qualification_score: number | null;
  lead_temperature: string | null;
  target_location: string | null;
  property_type: string | null;
  budget: string | null;
  timeline: string | null;
  financing_status: string | null;
  must_haves: string | null;
  motivation: string | null;
};

function hasQualifyingSignal(contact: ContactForIntake): boolean {
  return Boolean(
    contact.intent?.trim() ||
      contact.target_location?.trim() ||
      contact.property_type?.trim() ||
      contact.budget?.trim() ||
      contact.timeline?.trim() ||
      contact.financing_status?.trim() ||
      contact.must_haves?.trim() ||
      contact.motivation?.trim() ||
      contact.lead_status === "Working" ||
      contact.lead_status === "Contacted" ||
      contact.lead_status === "Qualified",
  );
}

function isScored(contact: ContactForIntake): boolean {
  return (
    typeof contact.qualification_score === "number" &&
    contact.qualification_score >= 0 &&
    Boolean(contact.lead_temperature?.trim())
  );
}

function isWarmOrCold(temperature: string | null | undefined): boolean {
  const t = temperature?.trim();
  return t === "Warm" || t === "Cold";
}

function toIntakeContactContext(contact: ContactForIntake): ContactContext {
  return {
    phone: "",
    leadStatus: (contact.lead_status as LeadStatus) || "New",
    readyToBook: Boolean(contact.ready_to_book),
    apptBooked: Boolean(contact.appt_booked),
    handoff: false,
    optedOut: false,
    intent: (contact.intent as LeadIntent) || null,
    targetLocation: contact.target_location ?? undefined,
    propertyType: contact.property_type ?? undefined,
    budget: contact.budget ?? undefined,
    timeline: contact.timeline ?? undefined,
    financingStatus: contact.financing_status ?? undefined,
    mustHaves: contact.must_haves ?? undefined,
    motivation: contact.motivation ?? undefined,
    qualificationScore: contact.qualification_score,
    leadTemperature: contact.lead_temperature as ContactContext["leadTemperature"],
  };
}

/**
 * Decide the Intake stage this contact should be in.
 * Appointment Set > Nurture (Warm/Cold + core intake done) > Qualified (Hot / ready) >
 * AI Qualifying > New.
 */
export function resolveIntakeStage(
  contact: ContactForIntake,
): OpportunityStage | null {
  if (contact.appt_booked) return "Appointment_Set";

  const coreDone = hasCoreQualificationFields(toIntakeContactContext(contact));

  if (isScored(contact)) {
    // Hot or actively booking → Qualified (consult path).
    if (
      contact.lead_temperature === "Hot" ||
      contact.ready_to_book
    ) {
      return "Qualified";
    }
    // Warm/Cold only go to Nurture after core intake is actually collected.
    if (isWarmOrCold(contact.lead_temperature) && !contact.ready_to_book) {
      return coreDone ? "Nurture" : "AI_Qualifying";
    }
    return coreDone ? "Qualified" : "AI_Qualifying";
  }
  if (hasQualifyingSignal(contact)) return "AI_Qualifying";
  return "New";
}

function formatUsdCents(cents: number): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 0,
  }).format(cents / 100);
}

function opportunityActivityBody(
  contact: ContactForIntake,
  amountCents?: number,
): string {
  const who = personDisplayName(contact.first_name, contact.last_name);
  const amount =
    amountCents != null ? formatUsdCents(amountCents) : null;
  const typeLabel = opportunityTypeFromIntent(contact.intent);
  const parts = [who];
  if (amount) parts.push(amount);
  parts.push(`${typeLabel} Opportunity`);
  return parts.join(" → ");
}

function stageNotes(stage: OpportunityStage): string {
  switch (stage) {
    case "Appointment_Set":
      return "Lead converted to Account when consult was booked.";
    case "Qualified":
      return "Advanced automatically when Concierge scored the lead.";
    case "Nurture":
      return "Moved automatically when lead scored Warm/Cold and is not booking.";
    case "AI_Qualifying":
      return "Created/advanced when Concierge started qualifying.";
    case "New":
      return "Created when the lead engaged; remains a Lead until consult is booked.";
    default:
      return "Synced automatically from Concierge intake.";
  }
}

/**
 * Convert Lead → Prospect Account only when a consult is booked (Appointment Set).
 * Engaged leads keep Intake opps (New → Nurture) while staying on the Leads board.
 */
async function ensureAccountOnAppointmentSet(
  contactId: string,
  target: OpportunityStage,
): Promise<void> {
  if (target !== "Appointment_Set") return;

  const db = getSupabaseAdmin();
  if (!db) return;

  const { error } = await db
    .from("contacts")
    .update({
      record_type: "contact",
      contact_type: "Prospect",
      lead_status: "Converted",
    })
    .eq("id", contactId)
    .neq("record_type", "contact");

  if (error) {
    console.error("ensureAccountOnAppointmentSet failed:", error);
  }
}

async function syncLeadStatusForStage(
  contactId: string,
  target: OpportunityStage,
  currentLeadStatus: string | null,
): Promise<void> {
  const db = getSupabaseAdmin();
  if (!db) return;

  const { data: contact } = await db
    .from("contacts")
    .select("tenant_id, first_name, last_name, lead_status")
    .eq("id", contactId)
    .maybeSingle();
  if (!contact) return;

  const label = personDisplayName(contact.first_name, contact.last_name);

  // Booking path: Lead → Account (Prospect) + Converted.
  if (target === "Appointment_Set") {
    await ensureAccountOnAppointmentSet(contactId, target);
    return;
  }

  if (currentLeadStatus === "Converted") return;

  if (target === "Nurture") {
    if (currentLeadStatus === "New" || currentLeadStatus === "Working") {
      await db
        .from("contacts")
        .update({ lead_status: "Contacted" })
        .eq("id", contactId);
      await logSystemContactActivity({
        tenantId: contact.tenant_id,
        contactId,
        activityType: "contact",
        title: "Lead status changed",
        body: `${label}: ${currentLeadStatus} → Contacted`,
        relatedEntityType: "lead",
        relatedEntityId: contactId,
      });
    }
    return;
  }

  if (target === "Qualified") {
    const { data: updated } = await db
      .from("contacts")
      .update({ lead_status: "Qualified" })
      .eq("id", contactId)
      .in("lead_status", ["New", "Working", "Contacted"])
      .select("id")
      .maybeSingle();
    if (updated?.id) {
      await logSystemContactActivity({
        tenantId: contact.tenant_id,
        contactId,
        activityType: "contact",
        title: "Lead qualified",
        body: label,
        relatedEntityType: "lead",
        relatedEntityId: contactId,
      });
    }
    return;
  }

  if (target === "AI_Qualifying" && currentLeadStatus === "New") {
    await db
      .from("contacts")
      .update({ lead_status: "Working" })
      .eq("id", contactId);
    await logSystemContactActivity({
      tenantId: contact.tenant_id,
      contactId,
      activityType: "contact",
      title: "Lead status changed",
      body: `${label}: New → Working`,
      relatedEntityType: "lead",
      relatedEntityId: contactId,
    });
  }
}

function opportunityPatchFromContact(contact: ContactForIntake): {
  opportunity_type: OpportunityType;
  amount_cents?: number;
} {
  const patch: { opportunity_type: OpportunityType; amount_cents?: number } = {
    opportunity_type: opportunityTypeFromIntent(contact.intent),
  };
  const amountCents = parseBudgetToCents(contact.budget);
  if (amountCents != null) patch.amount_cents = amountCents;
  return patch;
}

/**
 * Create or forward-advance the contact's Intake opportunity to match CRM state.
 * Does not move Closed Won backward; does not drop below Appointment Set.
 */
export async function syncIntakeOpportunityStage(
  contactId: string,
): Promise<string | null> {
  const db = getSupabaseAdmin();
  if (!db) {
    console.error("syncIntakeOpportunityStage: no Supabase admin client");
    return null;
  }

  const { data: contact, error: contactError } = await db
    .from("contacts")
    .select(
      "id, tenant_id, first_name, last_name, intent, appt_booked, ready_to_book, lead_status, qualification_score, lead_temperature, target_location, property_type, budget, timeline, financing_status, must_haves, motivation",
    )
    .eq("id", contactId)
    .maybeSingle();

  if (contactError || !contact) {
    console.error(
      "syncIntakeOpportunityStage contact load:",
      contactError ?? "not found",
      contactId,
    );
    return null;
  }

  const contactRow = contact as ContactForIntake;
  const target = resolveIntakeStage(contactRow);
  if (!target) return null;

  const fieldPatch = opportunityPatchFromContact(contactRow);

  const { data: existingRows, error: existingError } = await db
    .from("opportunities")
    .select("id, stage, amount_cents")
    .eq("tenant_id", contact.tenant_id)
    .eq("contact_id", contactId)
    .eq("pipeline", DEFAULT_OPPORTUNITY_PIPELINE)
    .order("created_at", { ascending: false })
    .limit(5);

  if (existingError) {
    console.error("syncIntakeOpportunityStage existing lookup:", existingError);
  }

  const openOpp = existingRows?.[0];
  if (openOpp?.id) {
    const shouldAdvance =
      openOpp.stage !== target && canAdvanceTo(openOpp.stage, target);
    const updatePayload: Record<string, string | number> = { ...fieldPatch };
    if (shouldAdvance) updatePayload.stage = target;

    const { error: updateError } = await db
      .from("opportunities")
      .update(updatePayload)
      .eq("id", openOpp.id);

    if (updateError) {
      console.error("syncIntakeOpportunityStage update failed:", updateError);
      return openOpp.id;
    }

    if (shouldAdvance) {
      console.log(
        "syncIntakeOpportunityStage advanced",
        openOpp.id,
        openOpp.stage,
        "→",
        target,
      );
      await syncLeadStatusForStage(contactId, target, contact.lead_status);

      const amountCents =
        typeof fieldPatch.amount_cents === "number"
          ? fieldPatch.amount_cents
          : typeof openOpp.amount_cents === "number"
            ? openOpp.amount_cents
            : undefined;

      if (target === "Appointment_Set") {
        await logSystemContactActivity({
          tenantId: contact.tenant_id,
          contactId,
          activityType: "appointment",
          title: "Appointment booked",
          body: opportunityActivityBody(contactRow, amountCents),
          relatedEntityType: "opportunity",
          relatedEntityId: openOpp.id,
        });
        await logSystemContactActivity({
          tenantId: contact.tenant_id,
          contactId,
          activityType: "contact",
          title: "Lead converted",
          body: personDisplayName(contact.first_name, contact.last_name),
          relatedEntityType: "contact",
          relatedEntityId: contactId,
        });
      } else {
        await logSystemContactActivity({
          tenantId: contact.tenant_id,
          contactId,
          activityType: "opportunity",
          title: "Opportunity stage changed",
          body: `${formatOpportunityStageLabel(openOpp.stage)} → ${formatOpportunityStageLabel(target)}`,
          relatedEntityType: "opportunity",
          relatedEntityId: openOpp.id,
        });
      }

      if (
        typeof fieldPatch.amount_cents === "number" &&
        fieldPatch.amount_cents !== openOpp.amount_cents
      ) {
        await logSystemContactActivity({
          tenantId: contact.tenant_id,
          contactId,
          activityType: "opportunity",
          title: "Opportunity value changed",
          body: formatUsdCents(fieldPatch.amount_cents),
          relatedEntityType: "opportunity",
          relatedEntityId: openOpp.id,
        });
      }
    } else if (
      typeof fieldPatch.amount_cents === "number" &&
      fieldPatch.amount_cents !== openOpp.amount_cents
    ) {
      await logSystemContactActivity({
        tenantId: contact.tenant_id,
        contactId,
        activityType: "opportunity",
        title: "Opportunity value changed",
        body: formatUsdCents(fieldPatch.amount_cents),
        relatedEntityType: "opportunity",
        relatedEntityId: openOpp.id,
      });
    }

    return openOpp.id;
  }

  const name = `${personDisplayName(contact.first_name, contact.last_name)} - Consult`;

  const payload = {
    tenant_id: contact.tenant_id,
    contact_id: contactId,
    name,
    pipeline: DEFAULT_OPPORTUNITY_PIPELINE,
    stage: target,
    ...fieldPatch,
    lead_source: "Other" as const,
    priority: target === "Appointment_Set" ? ("High" as const) : ("Medium" as const),
    notes: stageNotes(target),
  };

  const { data: opportunity, error } = await db
    .from("opportunities")
    .insert(payload)
    .select("id")
    .single();

  if (error || !opportunity) {
    console.error("syncIntakeOpportunityStage insert failed:", {
      message: error?.message,
      details: error?.details,
      hint: error?.hint,
      code: error?.code,
      payload,
    });
    return null;
  }

  console.log(
    "syncIntakeOpportunityStage created",
    opportunity.id,
    target,
    "for contact",
    contactId,
  );

  const amountCents =
    typeof fieldPatch.amount_cents === "number" ? fieldPatch.amount_cents : undefined;

  await logSystemContactActivity({
    tenantId: contact.tenant_id,
    contactId,
    activityType: "opportunity",
    title: "New Opportunity",
    body: opportunityActivityBody(contactRow, amountCents),
    relatedEntityType: "opportunity",
    relatedEntityId: opportunity.id,
  });

  if (target === "Appointment_Set") {
    await logSystemContactActivity({
      tenantId: contact.tenant_id,
      contactId,
      activityType: "appointment",
      title: "Appointment booked",
      body: opportunityActivityBody(contactRow, amountCents),
      relatedEntityType: "opportunity",
      relatedEntityId: opportunity.id,
    });
  }

  await syncLeadStatusForStage(contactId, target, contact.lead_status);
  return opportunity.id;
}

/**
 * When a consult is booked, ensure Intake opportunity is in Appointment Set.
 */
export async function ensureAppointmentSetOpportunity(
  contactId: string,
  options?: { requireApptBooked?: boolean },
): Promise<string | null> {
  const db = getSupabaseAdmin();
  if (!db) {
    console.error("ensureAppointmentSetOpportunity: no Supabase admin client");
    return null;
  }

  if (options?.requireApptBooked !== false) {
    const { data: contact } = await db
      .from("contacts")
      .select("appt_booked")
      .eq("id", contactId)
      .maybeSingle();
    if (!contact?.appt_booked) {
      console.warn(
        "ensureAppointmentSetOpportunity skipped: appt_booked=false",
        contactId,
      );
      return null;
    }
  }

  return syncIntakeOpportunityStage(contactId);
}
