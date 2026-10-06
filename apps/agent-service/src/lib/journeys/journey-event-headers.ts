/**
 * Request headers that opt a CRM write into a durable journey event (migration
 * 060), or say who made it (061). The trigger records the event in the same
 * transaction as the write, and only accepts the values listed here; see
 * 060_journey_events.sql and 061_journey_lifecycle_events.sql.
 */

export const LEAD_SOURCE_HEADER = "x-reos-lead-source";
export const LEAD_CHANNEL_HEADER = "x-reos-lead-channel";
export const MESSAGE_RECEIVED_HEADER = "x-reos-message-received";
export const APPOINTMENT_BOOKED_BY_HEADER = "x-reos-appointment-booked-by";
export const APPOINTMENT_RESCHEDULED_BY_HEADER = "x-reos-appointment-rescheduled-by";

export type LeadSource = "message" | "comment" | "manual";
export type LeadChannel = "sms" | "messenger" | "instagram";

export function leadCreatedHeaders(source: LeadSource, channel?: LeadChannel | null): Record<string, string> {
  return channel ? { [LEAD_SOURCE_HEADER]: source, [LEAD_CHANNEL_HEADER]: channel } : { [LEAD_SOURCE_HEADER]: source };
}

export function messageReceivedHeaders(): Record<string, string> {
  return { [MESSAGE_RECEIVED_HEADER]: "1" };
}

export function appointmentBookedHeaders(bookedBy: "agent" | "team"): Record<string, string> {
  return { [APPOINTMENT_BOOKED_BY_HEADER]: bookedBy };
}

/** appointment.rescheduled is recorded for every start-time change; this only names who moved it. */
export function appointmentRescheduledHeaders(rescheduledBy: "agent" | "team"): Record<string, string> {
  return { [APPOINTMENT_RESCHEDULED_BY_HEADER]: rescheduledBy };
}

export function withJourneyEventHeaders<Query extends { setHeader(name: string, value: string): Query }>(
  query: Query,
  headers: Record<string, string>,
): Query {
  let tagged = query;
  for (const [name, value] of Object.entries(headers)) {
    tagged = tagged.setHeader(name, value);
  }
  return tagged;
}
