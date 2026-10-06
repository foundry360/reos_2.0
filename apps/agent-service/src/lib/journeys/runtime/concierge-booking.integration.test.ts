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
const { bookReosConsultSlot } = await import("../../calendar/consult-appointments.ts");
const { mergeContacts } = await import("../../db/contact-merge.ts");

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
});
