import type { SupabaseClient } from "@supabase/supabase-js";

/** contact_activities.appointment_status (migration 062). Only scheduled changes; the rest are final. */
export const APPOINTMENT_STATUSES = ["scheduled", "cancelled", "completed", "no_show"] as const;
export type AppointmentStatus = (typeof APPOINTMENT_STATUSES)[number];
export type AppointmentOutcome = Exclude<AppointmentStatus, "scheduled">;

export const APPOINTMENT_STATUS_LABELS: Record<AppointmentStatus, string> = {
  scheduled: "Scheduled",
  cancelled: "Cancelled",
  completed: "Completed",
  no_show: "No-show",
};

/** Rows from before migration 062 (no status) are scheduled. */
export function appointmentStatusOf(value: unknown): AppointmentStatus {
  return APPOINTMENT_STATUSES.includes(value as AppointmentStatus) ? (value as AppointmentStatus) : "scheduled";
}

export interface AppointmentStatusChange {
  id: string;
  contactId: string;
  title: string | null;
  start: string;
  end: string | null;
  status: AppointmentOutcome;
  relatedEntityType: string | null;
  relatedEntityId: string | null;
  /** Metadata as written by the change (invite_* keys of the last invite included). */
  metadata: Record<string, unknown>;
  /** Set on a cancellation when an invite went out: the sequence its CANCEL must carry. */
  cancellationSequence: number | null;
}

export type SetAppointmentStatusResult = { ok: true; change: AppointmentStatusChange } | { ok: false; error: string };

const DONE_LABEL: Record<AppointmentOutcome, string> = {
  cancelled: "cancelled",
  completed: "marked completed",
  no_show: "marked as a no-show",
};

/**
 * Moves a scheduled appointment or meeting to cancelled, completed, or no_show.
 * Completed and no-show are recorded by the team once the appointment has
 * started; nothing infers them. The write only applies while the row is still
 * scheduled, so two people can't both change it. Migration 062 records the
 * journey event in the same transaction.
 */
export async function setAppointmentStatus(
  db: SupabaseClient,
  params: { tenantId: string; appointmentId: string; status: AppointmentOutcome; now: Date },
): Promise<SetAppointmentStatusResult> {
  const { data: row, error: loadError } = await db
    .from("contact_activities")
    .select(
      "id, contact_id, activity_type, title, occurred_at, ends_at, appointment_status, metadata, related_entity_type, related_entity_id",
    )
    .eq("id", params.appointmentId)
    .eq("tenant_id", params.tenantId)
    .maybeSingle();
  if (loadError) return { ok: false, error: loadError.message };
  if (!row) return { ok: false, error: "Appointment was not found." };
  if (row.activity_type !== "appointment" && row.activity_type !== "meeting") {
    return { ok: false, error: "That record is not an appointment." };
  }

  const current = appointmentStatusOf(row.appointment_status);
  if (current !== "scheduled") {
    return { ok: false, error: `This appointment was already ${DONE_LABEL[current]}.` };
  }
  if (params.status !== "cancelled" && Date.parse(row.occurred_at) > params.now.getTime()) {
    return { ok: false, error: `An appointment can't be ${DONE_LABEL[params.status]} before it starts.` };
  }

  const prior =
    row.metadata && typeof row.metadata === "object" && !Array.isArray(row.metadata)
      ? (row.metadata as Record<string, unknown>)
      : {};
  const invited = typeof prior.invite_sent_at === "string";
  const cancellationSequence =
    params.status === "cancelled" && invited
      ? (typeof prior.invite_sequence === "number" ? prior.invite_sequence : 0) + 1
      : null;
  const metadata: Record<string, unknown> = {
    ...prior,
    [`${params.status}_at`]: params.now.toISOString(),
    ...(cancellationSequence !== null ? { invite_sequence: cancellationSequence } : {}),
  };

  const { data: updated, error: updateError } = await db
    .from("contact_activities")
    .update({ appointment_status: params.status, metadata })
    .eq("id", row.id)
    .eq("tenant_id", params.tenantId)
    .eq("appointment_status", "scheduled")
    .select("id");
  if (updateError) return { ok: false, error: updateError.message };
  if (!updated || updated.length === 0) {
    return { ok: false, error: "This appointment was just changed. Refresh and try again." };
  }

  return {
    ok: true,
    change: {
      id: row.id,
      contactId: row.contact_id,
      title: row.title ?? null,
      start: row.occurred_at,
      end: row.ends_at ?? null,
      status: params.status,
      relatedEntityType: row.related_entity_type ?? null,
      relatedEntityId: row.related_entity_id ?? null,
      metadata,
      cancellationSequence,
    },
  };
}
