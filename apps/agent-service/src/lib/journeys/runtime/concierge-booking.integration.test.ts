/**
 * The concierge slot key (migration 060) through the real code paths: a
 * repeated booking of a slot the contact already holds (bookReosConsultSlot),
 * and a contact merge where both records hold the same slot (mergeContacts).
 * live-actions-test-env.ts must be the first import; it fails closed on any
 * other network access, so a re-sent invite would fail the test.
 */

import { attachTestDb, blockedRequests, providers } from "./live-actions-test-env.ts";

import assert from "node:assert/strict";
import { afterEach, after, beforeEach, describe, it } from "node:test";
import { appointmentBookedHeaders, withJourneyEventHeaders } from "../journey-event-headers.ts";
import { createJourneyEventsTestDb } from "./journey-events-test-db.ts";

/** The rest of the contact columns mergeContacts and bookReosConsultSlot read. */
const CONTACT_COLUMNS = `
alter table public.tenants add column timezone text;
alter table public.contacts
  add column lead_temperature text,
  add column ai_summary text,
  add column agent_brief text,
  add column recommended_next_action text,
  add column qualification_score integer,
  add column handoff boolean not null default false,
  add column opted_out boolean not null default false,
  add column assigned_agent_id uuid,
  add column target_location text,
  add column property_type text,
  add column budget text,
  add column timeline text,
  add column financing_status text,
  add column must_haves text,
  add column motivation text,
  add column preferences text,
  add column created_at timestamptz not null default now();
create table public.opportunities (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id) on delete cascade,
  contact_id uuid references public.contacts (id) on delete cascade
);
`;

const db = await createJourneyEventsTestDb(CONTACT_COLUMNS);
attachTestDb(db);
const { bookReosConsultSlot, rescheduleReosAppointment } = await import("../../calendar/consult-appointments.ts");
const { mergeContacts } = await import("../../db/contact-merge.ts");
const { setAppointmentStatus } = await import("../../calendar/appointment-status.ts");
const { sendAppointmentCancellation } = await import("../../calendar/appointment-invites.ts");

const service = db.client("service_role");

let tenant: string;

after(async () => {
  await db.pg.close();
});

beforeEach(async () => {
  await db.reset();
  providers.reset();
  [{ id: tenant }] = await db.query<{ id: string }>("insert into public.tenants default values returning id");
});

afterEach(() => {
  assert.deepEqual(blockedRequests, [], "no request may leave the test environment");
});

async function newContact(fields: Record<string, unknown> = {}): Promise<string> {
  const { data, error } = await service.from("contacts").insert({ tenant_id: tenant, ...fields }).select("id").single();
  assert.equal(error, null);
  return data!.id;
}

/** A concierge booking as bookReosConsultSlot stores it, recording appointment.booked. */
async function conciergeBooking(contactId: string, startIso: string): Promise<string> {
  const { data, error } = await withJourneyEventHeaders(
    service
      .from("contact_activities")
      .insert({
        tenant_id: tenant,
        contact_id: contactId,
        activity_type: "appointment",
        title: "Consult",
        occurred_at: startIso,
        ends_at: new Date(Date.parse(startIso) + 30 * 60_000).toISOString(),
        source: "concierge",
      })
      .select("id")
      .single(),
    appointmentBookedHeaders("agent"),
  );
  assert.equal(error, null);
  return data!.id;
}

/** A start bookReosConsultSlot accepts: on the hour, two days out. */
function upcomingStart(hoursLater = 0): string {
  const start = new Date(Date.now() + 2 * 24 * 60 * 60_000);
  start.setUTCMinutes(0, 0, 0);
  start.setUTCHours(start.getUTCHours() + hoursLater);
  return start.toISOString();
}

describe("repeated concierge booking of the same slot", () => {
  it("returns the existing appointment: no second appointment, appointment.booked, CRM update, or invite", async () => {
    const lead = await newContact({ email: "lead@example.test" });
    const start = upcomingStart();
    const existing = await conciergeBooking(lead, start);

    // The test database can't serve the availability lookup's range filters, so
    // this request goes ahead the way a concurrent one does once both passed it.
    const result = await bookReosConsultSlot({ tenantId: tenant, contactId: lead, start });

    assert.equal(result.ok, true);
    assert.ok(result.ok);
    assert.equal(result.appointmentId, existing);
    assert.match(result.confirmation, /^Already booked /);
    assert.equal((await db.query("select id from public.contact_activities")).length, 1);
    assert.deepEqual(
      (await db.query<{ event_type: string; source_id: string }>("select event_type, source_id from public.journey_events")).map((row) => [
        row.event_type,
        row.source_id,
      ]),
      [["appointment.booked", existing]],
    );
    const [contact] = await db.query<{ appt_booked: boolean; lead_status: string }>("select appt_booked, lead_status from public.contacts where id = $1", [lead]);
    assert.deepEqual(contact, { appt_booked: false, lead_status: "New" }, "the CRM update belongs to the request that booked");
    assert.equal(providers.resend.calls.length, 0, "no invite re-sent");
  });
});

describe("rescheduling a concierge booking (migration 061)", () => {
  it("moves the same row in place and records appointment.rescheduled by the agent with the old and new times", async () => {
    const lead = await newContact();
    const start = upcomingStart();
    const appointment = await conciergeBooking(lead, start);
    const newStart = upcomingStart(3);
    const newEnd = new Date(Date.parse(newStart) + 30 * 60_000).toISOString();

    const result = await rescheduleReosAppointment({ tenantId: tenant, appointmentId: appointment, start: newStart, end: newEnd });

    assert.ok(result.ok);
    assert.equal(result.appointmentId, appointment);
    const rows = await db.query<{ id: string; occurred_at: Date; metadata: { invite_sequence: number; reschedules: unknown[] } }>(
      "select id, occurred_at, metadata from public.contact_activities",
    );
    assert.equal(rows.length, 1, "same row, no new appointment");
    assert.equal(rows[0].occurred_at.toISOString(), newStart);
    assert.equal(rows[0].metadata.invite_sequence, 1);
    assert.equal(rows[0].metadata.reschedules.length, 1);
    const events = await db.query<{ event_type: string; entity_id: string; payload: Record<string, unknown> }>(
      "select event_type, entity_id, payload from public.journey_events order by created_at, id",
    );
    assert.deepEqual(events.map((row) => row.event_type), ["appointment.booked", "appointment.rescheduled"]);
    assert.equal(events[1].entity_id, appointment);
    assert.deepEqual(events[1].payload, {
      appointment_id: appointment,
      contact_id: lead,
      from_start: start,
      to_start: newStart,
      to_end: newEnd,
      rescheduled_by: "agent",
    });
  });
});

describe("merging contacts that hold the same concierge slot", () => {
  it("keeps one booking of the shared slot and moves every other activity of the loser", async () => {
    const winner = await newContact();
    const loser = await newContact();
    const shared = upcomingStart();
    const kept = await conciergeBooking(winner, shared);
    await conciergeBooking(loser, shared);
    const otherSlot = await conciergeBooking(loser, upcomingStart(2));
    const [{ id: note }] = await db.query<{ id: string }>(
      "insert into public.contact_activities (tenant_id, contact_id, activity_type, title) values ($1, $2, 'note', 'Prefers mornings') returning id",
      [tenant, loser],
    );

    assert.equal(await mergeContacts(winner, loser), winner);

    assert.equal((await db.query("select id from public.contacts where id = $1", [loser])).length, 0);
    const activities = await db.query<{ id: string; contact_id: string }>("select id, contact_id from public.contact_activities order by id");
    assert.deepEqual(activities.map((row) => row.id).sort(), [kept, otherSlot, note].sort());
    assert.ok(activities.every((row) => row.contact_id === winner));
  });

  it("a cancelled booking of the shared slot isn't a duplicate: it moves to the winner as history (migration 062)", async () => {
    const winner = await newContact();
    const loser = await newContact();
    const shared = upcomingStart();
    const kept = await conciergeBooking(winner, shared);
    const cancelled = await conciergeBooking(loser, shared);
    assert.ok((await setAppointmentStatus(service, { tenantId: tenant, appointmentId: cancelled, status: "cancelled", now: new Date() })).ok);

    assert.equal(await mergeContacts(winner, loser), winner);

    const rows = await db.query<{ id: string; contact_id: string; appointment_status: string }>(
      "select id, contact_id, appointment_status from public.contact_activities order by id",
    );
    assert.deepEqual(
      rows.map((row) => [row.id, row.appointment_status]).sort(),
      [
        [kept, "scheduled"],
        [cancelled, "cancelled"],
      ].sort(),
    );
    assert.ok(rows.every((row) => row.contact_id === winner));
  });
});

/** Metadata as sendAppointmentInvites leaves it after inviting both people. */
const INVITED = {
  invite_sent_at: "2026-10-01T12:00:00.000Z",
  invite_lead_sent: true,
  invite_agent_sent: true,
  invite_lead_email: "lead@example.test",
  invite_agent_email: "agent@broker.test",
};

async function invitedBooking(contactId: string, startIso: string, metadata: Record<string, unknown> = INVITED) {
  const id = await conciergeBooking(contactId, startIso);
  await db.query("update public.contact_activities set metadata = $2 where id = $1", [id, JSON.stringify(metadata)]);
  return id;
}

/** Cancels the way cancelCalendarAppointmentAction does: the status change, then the CANCEL to whoever got the invite. */
async function cancelAppointment(appointmentId: string) {
  const result = await setAppointmentStatus(service, { tenantId: tenant, appointmentId, status: "cancelled", now: new Date() });
  assert.ok(result.ok, result.ok ? "" : result.error);
  const { change } = result;
  if (change.cancellationSequence === null) return { change, sent: null };
  const start = new Date(change.start);
  const sent = await sendAppointmentCancellation({
    tenantId: tenant,
    appointmentId: change.id,
    summary: change.title ?? "Appointment",
    label: "Thu, Oct 8 at 3:00 PM",
    start,
    end: change.end ? new Date(change.end) : new Date(start.getTime() + 30 * 60_000),
    sequence: change.cancellationSequence,
    metadata: change.metadata,
  });
  return { change, sent };
}

describe("cancelling a concierge booking (migration 062)", () => {
  it("keeps the row as cancelled with its history, and sends a METHOD:CANCEL for the same invite to the people who got it", async () => {
    const lead = await newContact({ email: "lead@example.test" });
    const start = upcomingStart();
    const appointment = await invitedBooking(lead, start);

    const { change, sent } = await cancelAppointment(appointment);

    assert.equal(change.cancellationSequence, 1);
    assert.deepEqual(sent, { inviteSent: true, leadSent: true, agentSent: true, errors: [] });
    const rows = await db.query<{ id: string; appointment_status: string; occurred_at: Date; metadata: Record<string, unknown> }>(
      "select id, appointment_status, occurred_at, metadata from public.contact_activities",
    );
    assert.equal(rows.length, 1, "not deleted");
    assert.equal(rows[0].appointment_status, "cancelled");
    assert.equal(rows[0].occurred_at.toISOString(), start);
    assert.deepEqual({ ...rows[0].metadata, cancelled_at: "x" }, { ...INVITED, invite_sequence: 1, cancelled_at: "x" });

    assert.deepEqual(providers.resend.calls.map((call) => call.to), [["lead@example.test"], ["agent@broker.test"]]);
    for (const call of providers.resend.calls) {
      assert.match(call.subject, /^Cancelled: Consult \(/);
      assert.equal(call.attachments.length, 1);
      const [ics] = call.attachments;
      assert.equal(ics.filename, "cancel.ics");
      assert.equal(ics.contentType, "text/calendar; method=CANCEL");
      assert.match(ics.content, /METHOD:CANCEL/);
      assert.match(ics.content, new RegExp(`UID:${appointment}@reos`));
      assert.match(ics.content, /SEQUENCE:1/);
      assert.match(ics.content, /STATUS:CANCELLED/);
      assert.match(ics.content, /ORGANIZER[^:]*:mailto:agent@broker\.test/);
    }
    const events = await db.query<{ event_type: string }>("select event_type from public.journey_events order by created_at, id");
    assert.deepEqual(events.map((row) => row.event_type), ["appointment.booked", "appointment.cancelled"]);
  });

  it("after reschedules the cancellation's sequence is higher than the last update's", async () => {
    const lead = await newContact();
    const appointment = await invitedBooking(lead, upcomingStart(), { ...INVITED, invite_sequence: 2, invite_agent_sent: false });
    const { change, sent } = await cancelAppointment(appointment);
    assert.equal(change.cancellationSequence, 3);
    assert.deepEqual(sent, { inviteSent: true, leadSent: true, agentSent: false, errors: [] });
    assert.deepEqual(providers.resend.calls.map((call) => call.to), [["lead@example.test"]]);
    assert.match(providers.resend.calls[0].attachments[0].content, /SEQUENCE:3/);
  });

  it("sends nothing when no invite went out", async () => {
    const lead = await newContact();
    const appointment = await conciergeBooking(lead, upcomingStart());
    const { change, sent } = await cancelAppointment(appointment);
    assert.equal(change.cancellationSequence, null);
    assert.equal(sent, null);
    const none = await sendAppointmentCancellation({
      tenantId: tenant, appointmentId: appointment, summary: "Consult", label: "-", start: new Date(), end: new Date(), sequence: 1, metadata: {},
    });
    assert.deepEqual(none, { inviteSent: false, leadSent: false, agentSent: false, errors: [] });
    assert.equal(providers.resend.calls.length, 0);
  });

  it("frees the slot: the contact can book the same time again, while a scheduled booking still holds it", async () => {
    const lead = await newContact();
    const start = upcomingStart();
    const first = await conciergeBooking(lead, start);
    const insertSameSlot = () =>
      service.from("contact_activities").insert({
        tenant_id: tenant, contact_id: lead, activity_type: "appointment", title: "Consult", occurred_at: start, source: "concierge",
      });
    assert.match((await insertSameSlot()).error?.message ?? "", /concierge_slot_key|duplicate/);
    await cancelAppointment(first);

    // The test database can't serve the availability lookup's range filters; the
    // existing-booking check is what would otherwise return "Already booked".
    const result = await bookReosConsultSlot({ tenantId: tenant, contactId: lead, start });

    assert.ok(result.ok, result.ok ? "" : result.error);
    assert.notEqual(result.appointmentId, first);
    assert.doesNotMatch(result.confirmation, /^Already booked /);
    const rows = await db.query<{ id: string; appointment_status: string }>("select id, appointment_status from public.contact_activities");
    assert.deepEqual(
      rows.map((row) => [row.id, row.appointment_status]).sort(),
      [
        [first, "cancelled"],
        [result.appointmentId, "scheduled"],
      ].sort(),
    );

    // Booking it a third time finds the scheduled booking, not the cancelled one.
    const again = await bookReosConsultSlot({ tenantId: tenant, contactId: lead, start });
    assert.ok(again.ok, again.ok ? "" : again.error);
    assert.equal(again.appointmentId, result.appointmentId);
    assert.match(again.confirmation, /^Already booked /);
  });

  it("a cancelled appointment can't be rescheduled", async () => {
    const lead = await newContact();
    const start = upcomingStart();
    const appointment = await conciergeBooking(lead, start);
    await cancelAppointment(appointment);
    const newStart = upcomingStart(3);
    const result = await rescheduleReosAppointment({
      tenantId: tenant, appointmentId: appointment, start: newStart, end: new Date(Date.parse(newStart) + 30 * 60_000).toISOString(),
    });
    assert.deepEqual(result, { ok: false, error: "That appointment is cancelled, so it can't be moved." });
    const [row] = await db.query<{ occurred_at: Date }>("select occurred_at from public.contact_activities where id = $1", [appointment]);
    assert.equal(row.occurred_at.toISOString(), start);
  });
});
