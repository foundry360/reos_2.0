import { getSupabaseAdmin } from "@/lib/supabase/admin";
import type {
  ActivityRelatedEntityType,
  StoredActivityType,
} from "@/lib/crm/person-activities";

/** System CRM activity log (agent / admin paths). Skips chat — only durable events. */
export async function logSystemContactActivity(params: {
  tenantId: string;
  contactId: string;
  activityType: StoredActivityType;
  title: string;
  body?: string | null;
  relatedEntityType?: ActivityRelatedEntityType | null;
  relatedEntityId?: string | null;
}): Promise<void> {
  const db = getSupabaseAdmin();
  if (!db) return;

  const payload = {
    tenant_id: params.tenantId,
    contact_id: params.contactId,
    activity_type: params.activityType,
    title: params.title,
    body: params.body?.trim() || null,
    occurred_at: new Date().toISOString(),
    related_entity_type: params.relatedEntityType ?? null,
    related_entity_id: params.relatedEntityId ?? null,
  };

  let { error } = await db.from("contact_activities").insert(payload);

  if (error && /related_entity|schema cache|column/i.test(error.message)) {
    const { related_entity_type: _t, related_entity_id: _i, ...legacy } = payload;
    ({ error } = await db.from("contact_activities").insert(legacy));
  }

  if (error && /activity_type|check constraint/i.test(error.message)) {
    const asOther = { ...payload, activity_type: "other" as const };
    ({ error } = await db.from("contact_activities").insert(asOther));
  }

  if (error) {
    console.error("logSystemContactActivity failed:", error.message);
  }
}
