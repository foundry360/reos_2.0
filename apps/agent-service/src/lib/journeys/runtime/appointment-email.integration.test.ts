/**
 * E.2 appointment email outbound truth: invite, reschedule and cancellation
 * email through the crm_emails outbound record (migration 065), with stable
 * idempotency keys, cancellation decided by what was actually sent, and the
 * operation's own purpose (the lead's copy is transactional, the agent's is
 * operational), never the contact's email unsubscribe.
 *
 * The real sendAppointmentInvites / sendAppointmentCancellation, outbound
 * email record, and Resend sender run unmodified; Supabase is PGlite behind
 * the PostgREST bridge with the real migrations 060–065, and Resend is a
 * recorded fake. live-actions-test-env.ts must be the first import; it fails
 * closed on any other network access.
 */

import { attachTestDb, blockedRequests, providers } from "./live-actions-test-env.ts";

import assert from "node:assert/strict";
import { after, afterEach, beforeEach, describe, it } from "node:test";
import { createJourneyEventsTestDb } from "./journey-events-test-db.ts";

const db = await createJourneyEventsTestDb();
attachTestDb(db);
const { sendAppointmentInvites, sendAppointmentCancellation, appointmentEmailKey } = await import("../../calendar/appointment-invites.ts");

const START = new Date("2026-10-08T22:00:00.000Z");
const END = new Date("2026-10-08T22:30:00.000Z");
const LABEL = "Thu, Oct 8 at 3:00 PM";
const LEAD_EMAIL = "ana@example.com";
const AGENT_EMAIL = "agent@broker.test";

let tenant: string;
let lead: string;
let appointment: string;

/** Runs before each Resend request reaches the fake, to look at the database at that moment. */
let beforeResend: (() => Promise<void>) | null = null;
const environmentFetch = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  if (beforeResend && url.startsWith("https://api.resend.com/")) await beforeResend();
  return environmentFetch(input, init);
};

after(async () => {
  globalThis.fetch = environmentFetch;
  await db.pg.close();
});

beforeEach(async () => {
  await db.reset();
  providers.reset();
  beforeResend = null;
  [{ id: tenant }] = await db.query<{ id: string }>("insert into public.tenants default values returning id");
  lead = await newContact(LEAD_EMAIL);
  appointment = await newAppointment(lead);
});

afterEach(() => {
  assert.deepEqual(blockedRequests, [], "no request may leave the test environment");
});

// ---------- Seed helpers (direct SQL, outside the code under test) ----------

async function newContact(email: string, fields: { unsubscribedAt?: string; tenantId?: string } = {}): Promise<string> {
  const [{ id }] = await db.query<{ id: string }>(
    "insert into public.contacts (tenant_id, first_name, last_name, email, email_unsubscribed_at) values ($1, 'Ana', 'Lima', $2, $3) returning id",
    [fields.tenantId ?? tenant, email, fields.unsubscribedAt ?? null],
  );
  return id;
}

async function newAppointment(contactId: string, tenantId = tenant): Promise<string> {
  const [{ id }] = await db.query<{ id: string }>(
    `insert into public.contact_activities (tenant_id, contact_id, activity_type, title, occurred_at, ends_at, source)
     values ($1, $2, 'appointment', 'Consult', $3, $4, 'manual') returning id`,
    [tenantId, contactId, START.toISOString(), END.toISOString()],
  );
  return id;
}

/** A recorded appointment email, as an earlier attempt left it. */
async function seedEmail(notification: string, sequence: number, role: "lead" | "agent", status: string, providerId: string | null = null) {
  await db.query(
    `insert into public.crm_emails (tenant_id, contact_id, provider, provider_message_id, thread_id, direction, from_email, to_recipients, subject, status, idempotency_key, metadata)
     values ($1, $2, 'resend', $3, $4, 'outbound', 'noreply@reos.test', $5, 'Calendar invite: Consult', $6, $7, $8)`,
    [
      tenant,
      role === "lead" ? lead : null,
      providerId,
      `appointment:${appointment}`,
      JSON.stringify([{ email: role === "lead" ? LEAD_EMAIL : AGENT_EMAIL, name: null }]),
      status,
      appointmentEmailKey(appointment, notification as "invite", sequence, role),
      JSON.stringify({
        purpose: role === "lead" ? "transactional" : "operational",
        appointment_id: appointment,
        appointment_notification: notification,
        recipient_role: role,
        sequence,
        organizer_email: AGENT_EMAIL,
      }),
    ],
  );
}

interface EmailRow {
  id: string;
  tenant_id: string;
  contact_id: string | null;
  provider: string;
  provider_message_id: string | null;
  thread_id: string;
  direction: string;
  to_recipients: { email: string; name: string | null }[];
  subject: string;
  body_html: string;
  status: string;
  send_error: string | null;
  sent_at: Date | null;
  idempotency_key: string;
  metadata: Record<string, unknown>;
}

function emails(): Promise<EmailRow[]> {
  return db.query<EmailRow>("select * from public.crm_emails order by idempotency_key");
}

async function emailFor(key: string): Promise<EmailRow> {
  const [row] = await db.query<EmailRow>("select * from public.crm_emails where idempotency_key = $1", [key]);
  assert.ok(row, `no record for ${key}`);
  return row;
}

async function appointmentMetadata(): Promise<Record<string, unknown>> {
  const [row] = await db.query<{ metadata: Record<string, unknown> | null }>("select metadata from public.contact_activities where id = $1", [appointment]);
  return row.metadata ?? {};
}

async function withoutPrivilege<T>(table: string, privilege: "insert" | "update" | "select", work: () => Promise<T>): Promise<T> {
  await db.query(`revoke ${privilege} on public.${table} from service_role`);
  try {
    return await work();
  } finally {
    await db.query(`grant ${privilege} on public.${table} to service_role`);
  }
}

const timeout = () => Object.assign(new Error("The operation was aborted due to timeout"), { name: "TimeoutError" });

function invite(extra: Record<string, unknown> = {}) {
  return sendAppointmentInvites({
    tenantId: tenant,
    appointmentId: appointment,
    summary: "Consult",
    label: LABEL,
    start: START,
    end: END,
    lead: { email: LEAD_EMAIL, name: "Ana Lima" },
    agentUserId: null,
    organizerFallback: { email: AGENT_EMAIL, name: "Jordan Agent" },
    ...extra,
  });
}

function reschedule(sequence: number) {
  return invite({ start: new Date(START.getTime() + 3_600_000), end: new Date(END.getTime() + 3_600_000), update: { sequence, previousLabel: LABEL } });
}

function cancel(sequence: number, metadata: Record<string, unknown> = {}) {
  return sendAppointmentCancellation({ tenantId: tenant, appointmentId: appointment, summary: "Consult", label: LABEL, start: START, end: END, sequence, metadata });
}

const key = (notification: "invite" | "reschedule" | "cancellation", sequence: number, role: "lead" | "agent") =>
  `appointment:${appointment}:${notification}:${sequence}:${role}`;

const sentTo = () => providers.resend.calls.map((call) => call.to.join(","));

// ---------- Outbound lifecycle ----------

describe("appointment email lifecycle: pending → sent / failed / unknown", () => {
  it("records each email as pending before Resend is called, then sent with Resend's id", async () => {
    const statusesAtSend: string[][] = [];
    beforeResend = async () => {
      statusesAtSend.push((await emails()).map((row) => `${row.metadata.recipient_role}:${row.status}`));
    };

    const result = await invite();

    assert.deepEqual(result, { inviteSent: true, leadSent: true, agentSent: true, errors: [] });
    assert.deepEqual(statusesAtSend, [["lead:pending"], ["agent:pending", "lead:sent"]]);
    const leadRow = await emailFor(key("invite", 0, "lead"));
    assert.equal(leadRow.status, "sent");
    assert.equal(leadRow.provider_message_id, "resend-email-1");
    assert.ok(leadRow.sent_at);
    assert.equal(leadRow.send_error, null);
    assert.equal(leadRow.contact_id, lead, "the lead's copy is on the contact's email history");
    assert.equal(leadRow.direction, "outbound");
    assert.equal(leadRow.provider, "resend");
    assert.equal(leadRow.thread_id, `appointment:${appointment}`);
    assert.deepEqual(leadRow.to_recipients, [{ email: LEAD_EMAIL, name: "Ana Lima" }]);
    assert.deepEqual(leadRow.metadata, {
      purpose: "transactional",
      appointment_id: appointment,
      appointment_notification: "invite",
      recipient_role: "lead",
      sequence: 0,
      organizer_email: AGENT_EMAIL,
      reply_to: AGENT_EMAIL,
    });
    const agentRow = await emailFor(key("invite", 0, "agent"));
    assert.equal(agentRow.status, "sent");
    assert.equal(agentRow.provider_message_id, "resend-email-2");
    assert.equal(agentRow.contact_id, null, "the agent's copy isn't email to the contact");
    assert.equal(agentRow.metadata.purpose, "operational");

    // Content is unchanged: subject, body, the calendar attachment, and Resend's idempotency key.
    const [leadCall, agentCall] = providers.resend.calls;
    assert.deepEqual(sentTo(), [`Ana Lima <${LEAD_EMAIL}>`, `Jordan Agent <${AGENT_EMAIL}>`]);
    assert.equal(leadCall.subject, "Calendar invite: Consult");
    assert.equal(leadCall.html, leadRow.body_html);
    assert.match(leadCall.html, /Your consult is confirmed\./);
    assert.match(agentCall.html, /A consult was booked on your REOS calendar\./);
    assert.equal(leadCall.replyTo, AGENT_EMAIL);
    assert.equal(leadCall.idempotencyKey, key("invite", 0, "lead"));
    assert.equal(agentCall.idempotencyKey, key("invite", 0, "agent"));
    for (const call of providers.resend.calls) {
      assert.equal(call.attachments.length, 1);
      assert.equal(call.attachments[0].filename, "invite.ics");
      assert.equal(call.attachments[0].contentType, "text/calendar; method=REQUEST");
      assert.match(call.attachments[0].content, new RegExp(`UID:${appointment}@reos`));
      assert.match(call.attachments[0].content, /SEQUENCE:0/);
    }

    const metadata = await appointmentMetadata();
    assert.ok(metadata.invite_sent_at);
    assert.equal(metadata.invite_lead_sent, true);
    assert.equal(metadata.invite_agent_sent, true);
  });

  it("an email that can't be recorded isn't sent", async () => {
    const result = await withoutPrivilege("crm_emails", "insert", () => invite());

    assert.equal(result.inviteSent, false);
    assert.deepEqual(result.errors, [
      "Lead: The email couldn't be recorded, so it wasn't sent.",
      "Agent: The email couldn't be recorded, so it wasn't sent.",
    ]);
    assert.equal(providers.resend.calls.length, 0);
    assert.equal((await appointmentMetadata()).invite_sent_at, undefined);
  });

  it("a rejection is recorded as failed, never as sent", async () => {
    providers.resend.respondNext(422, { name: "validation_error", message: "Invalid `to` field." });

    const result = await invite();

    assert.deepEqual(result, { inviteSent: true, leadSent: false, agentSent: true, errors: ["Lead: Invalid `to` field."] });
    const leadRow = await emailFor(key("invite", 0, "lead"));
    assert.equal(leadRow.status, "failed");
    assert.equal(leadRow.send_error, "Invalid `to` field.");
    assert.equal(leadRow.provider_message_id, null);
    assert.equal(leadRow.sent_at, null);
    const metadata = await appointmentMetadata();
    assert.equal(metadata.invite_lead_sent, false);
    assert.equal(metadata.invite_agent_sent, true);
  });

  const ambiguous: [string, () => void, RegExp][] = [
    ["a timeout", () => providers.resend.throwNext(timeout()), /timed out; the message may have been sent/],
    ["a connection failure", () => providers.resend.throwNext(new TypeError("fetch failed")), /failed without a response/],
    ["a 5xx", () => providers.resend.respondNext(503, { message: "Service unavailable" }), /didn't confirm the send/],
    ["a 2xx without an id", () => providers.resend.respondNext(200, {}), /without an email id; it may have been sent/],
    ["a 409 (idempotency key in use)", () => providers.resend.respondNext(409, { message: "Concurrent request" }), /it may have been sent/],
  ];
  for (const [label, script, error] of ambiguous) {
    it(`${label} is recorded as unknown, never as sent`, async () => {
      script();
      const result = await invite();

      assert.equal(result.leadSent, false);
      assert.match(result.errors[0], error);
      const leadRow = await emailFor(key("invite", 0, "lead"));
      assert.equal(leadRow.status, "unknown");
      assert.match(leadRow.send_error ?? "", error);
      assert.equal(leadRow.sent_at, null);
      assert.equal((await appointmentMetadata()).invite_lead_sent, false);
    });
  }

  it("a provider answer that can't be recorded leaves the row pending (unconfirmed), not sent", async () => {
    beforeResend = async () => {
      await db.query("revoke update on public.crm_emails from service_role");
    };
    try {
      await invite();
    } finally {
      await db.query("grant update on public.crm_emails to service_role");
    }
    assert.deepEqual((await emails()).map((row) => row.status), ["pending", "pending"]);
  });
});

// ---------- Idempotency ----------

describe("appointment email idempotency", () => {
  it("repeating a confirmed invite returns it as sent without a second email", async () => {
    await invite();
    const again = await invite();

    assert.deepEqual(again, { inviteSent: true, leadSent: true, agentSent: true, errors: [] });
    assert.equal(providers.resend.calls.length, 2, "one email per person");
    assert.equal((await emails()).length, 2);
    assert.equal((await emailFor(key("invite", 0, "lead"))).provider_message_id, "resend-email-1");
  });

  it("a failed email is claimed back and retried under the same key", async () => {
    providers.resend.respondNext(422, { message: "Invalid `to` field." });
    await invite();
    const retry = await invite();

    assert.deepEqual(retry, { inviteSent: true, leadSent: true, agentSent: true, errors: [] });
    assert.deepEqual(
      providers.resend.calls.map((call) => call.idempotencyKey),
      [key("invite", 0, "lead"), key("invite", 0, "agent"), key("invite", 0, "lead")],
    );
    const leadRow = await emailFor(key("invite", 0, "lead"));
    assert.equal(leadRow.status, "sent");
    assert.equal(leadRow.send_error, null);
    assert.equal((await emails()).length, 2, "the same record, not a second one");
  });

  it("an unknown email is never resent", async () => {
    providers.resend.throwNext(timeout());
    await invite();
    const again = await invite();

    assert.deepEqual(again.errors, ["Lead: An earlier attempt at this email wasn't confirmed, so it wasn't sent again."]);
    assert.equal(again.leadSent, false);
    assert.equal(again.agentSent, true);
    assert.equal(providers.resend.calls.length, 2, "lead once (unknown), agent once");
    assert.equal((await emailFor(key("invite", 0, "lead"))).status, "unknown");
  });

  it("a pending email (a crash before the provider call) is never resent", async () => {
    await seedEmail("invite", 0, "lead", "pending");
    const result = await invite();

    assert.equal(result.leadSent, false);
    assert.deepEqual(result.errors, ["Lead: An earlier attempt at this email wasn't confirmed, so it wasn't sent again."]);
    assert.deepEqual(sentTo(), [`Jordan Agent <${AGENT_EMAIL}>`]);
  });

  it("invite, reschedule and cancellation each have their own stable identity", async () => {
    await invite();
    await reschedule(1);
    await reschedule(1);
    await reschedule(2);
    await cancel(3);
    await cancel(3);

    assert.deepEqual(
      providers.resend.calls.map((call) => call.idempotencyKey),
      [
        key("invite", 0, "lead"), key("invite", 0, "agent"),
        key("reschedule", 1, "lead"), key("reschedule", 1, "agent"),
        key("reschedule", 2, "lead"), key("reschedule", 2, "agent"),
        key("cancellation", 3, "lead"), key("cancellation", 3, "agent"),
      ],
    );
    assert.deepEqual(
      (await emails()).map((row) => row.idempotency_key).sort(),
      providers.resend.calls.map((call) => call.idempotencyKey).sort(),
    );
    const rescheduled = providers.resend.calls[2];
    assert.equal(rescheduled.subject, `Rescheduled: Consult (${LABEL})`);
    assert.match(rescheduled.attachments[0].content, /SEQUENCE:1/);
  });

  it("another tenant can't send email for this tenant's appointment", async () => {
    await invite();
    const otherTenant = (await db.query<{ id: string }>("insert into public.tenants default values returning id"))[0].id;
    const result = await sendAppointmentInvites({
      tenantId: otherTenant,
      appointmentId: appointment,
      summary: "Consult",
      label: LABEL,
      start: START,
      end: END,
      lead: { email: "other@example.com", name: null },
      agentUserId: null,
      organizerFallback: { email: AGENT_EMAIL, name: null },
    });
    assert.deepEqual(result.errors, ["The appointment couldn't be found, so no invite was sent."]);
    assert.equal(providers.resend.calls.length, 2);
    assert.ok((await emails()).every((row) => row.tenant_id === tenant));
  });
});

// ---------- Cancellation truth ----------

describe("appointment cancellation follows what was actually sent", () => {
  it("a confirmed invite gets a cancellation, to the address and from the organizer on record", async () => {
    await invite();
    providers.reset();

    const result = await cancel(1);

    assert.deepEqual(result, { inviteSent: true, leadSent: true, agentSent: true, errors: [] });
    assert.deepEqual(providers.resend.calls.map((call) => call.to), [[LEAD_EMAIL], [AGENT_EMAIL]]);
    for (const call of providers.resend.calls) {
      assert.match(call.subject, /^Cancelled: Consult \(/);
      assert.equal(call.attachments[0].filename, "cancel.ics");
      assert.match(call.attachments[0].content, /METHOD:CANCEL/);
      assert.match(call.attachments[0].content, /SEQUENCE:1/);
      assert.match(call.attachments[0].content, /ORGANIZER[^:]*:mailto:agent@broker\.test/);
    }
    const cancelled = await emailFor(key("cancellation", 1, "lead"));
    assert.equal(cancelled.status, "sent");
    assert.equal(cancelled.metadata.purpose, "transactional");
    assert.equal(cancelled.metadata.appointment_notification, "cancellation");
  });

  it("a failed invite gets no cancellation", async () => {
    await seedEmail("invite", 0, "lead", "failed");
    await seedEmail("invite", 0, "agent", "sent", "resend-x");

    const result = await cancel(1);

    assert.deepEqual(result, { inviteSent: true, leadSent: false, agentSent: true, errors: [] });
    assert.deepEqual(providers.resend.calls.map((call) => call.to), [[AGENT_EMAIL]]);
  });

  for (const status of ["unknown", "pending"]) {
    it(`an ${status} invite gets no cancellation, and the agent is told to reach the lead`, async () => {
      await seedEmail("invite", 0, "lead", status);
      await seedEmail("invite", 0, "agent", "sent", "resend-x");

      const result = await cancel(1);

      assert.equal(result.leadSent, false);
      assert.equal(result.agentSent, true);
      assert.deepEqual(result.errors, [
        "Lead: the invite was never confirmed as sent, so no cancellation was emailed. Let them know directly.",
      ]);
      assert.deepEqual(providers.resend.calls.map((call) => call.to), [[AGENT_EMAIL]]);
    });
  }

  it("no invite on record and none in the metadata: nothing is sent", async () => {
    const result = await cancel(1);
    assert.deepEqual(result, { inviteSent: false, leadSent: false, agentSent: false, errors: [] });
    assert.equal(providers.resend.calls.length, 0);
  });

  it("the record wins over stale metadata: an unknown invite isn't treated as sent", async () => {
    await seedEmail("invite", 0, "lead", "unknown");
    const result = await cancel(1, { invite_lead_sent: false, invite_lead_email: LEAD_EMAIL, invite_sent_at: "2026-10-01T12:00:00.000Z" });
    assert.equal(result.leadSent, false);
    assert.equal(providers.resend.calls.length, 0);
  });

  it("a sent invite then an unknown reschedule: the lead holds the invite, so it is cancelled", async () => {
    await seedEmail("invite", 0, "lead", "sent", "resend-a");
    await seedEmail("reschedule", 1, "lead", "unknown");

    const result = await cancel(2);

    assert.equal(result.leadSent, true);
    assert.deepEqual(result.errors, []);
    assert.deepEqual(providers.resend.calls.map((call) => call.to), [[LEAD_EMAIL]]);
  });

  it("when the record can't be read, nothing is sent", async () => {
    await invite();
    providers.reset();
    const result = await withoutPrivilege("crm_emails", "select", () => cancel(1));
    assert.deepEqual(result, {
      inviteSent: false, leadSent: false, agentSent: false,
      errors: ["Couldn't check which invites were sent, so no cancellation was emailed."],
    });
    assert.equal(providers.resend.calls.length, 0);
  });

  it("a cancellation that times out is unknown and isn't resent on a repeat", async () => {
    await invite();
    providers.reset();
    providers.resend.throwNext(timeout());
    const first = await cancel(1);
    const again = await cancel(1);

    assert.equal(first.leadSent, false);
    assert.equal(again.leadSent, false);
    assert.deepEqual(again.errors, ["Lead: An earlier attempt at this email wasn't confirmed, so it wasn't sent again."]);
    assert.deepEqual(providers.resend.calls.map((call) => call.to), [[LEAD_EMAIL], [AGENT_EMAIL]]);
    assert.equal((await emailFor(key("cancellation", 1, "lead"))).status, "unknown");
  });
});

// ---------- Purpose: transactional and operational ----------

describe("appointment email purpose is set by the operation", () => {
  it("an unsubscribed lead still gets the invite, reschedule and cancellation (transactional)", async () => {
    await db.query("update public.contacts set email_unsubscribed_at = now() where id = $1", [lead]);

    assert.equal((await invite()).leadSent, true);
    assert.equal((await reschedule(1)).leadSent, true);
    assert.equal((await cancel(2)).leadSent, true);

    const leadRows = (await emails()).filter((row) => row.metadata.recipient_role === "lead");
    assert.equal(leadRows.length, 3);
    assert.ok(leadRows.every((row) => row.status === "sent" && row.metadata.purpose === "transactional"));
  });

  it("the agent's copy isn't subject to a contact's unsubscribe, even one with the agent's address", async () => {
    await newContact(AGENT_EMAIL, { unsubscribedAt: "2026-09-01T00:00:00.000Z" });

    const result = await invite();

    assert.equal(result.agentSent, true);
    assert.equal((await emailFor(key("invite", 0, "agent"))).metadata.purpose, "operational");
  });

  it("a caller can't choose the purpose", async () => {
    await db.query("update public.contacts set email_unsubscribed_at = now() where id = $1", [lead]);

    const result = await invite({ purpose: "marketing" });

    assert.equal(result.leadSent, true);
    assert.equal((await emailFor(key("invite", 0, "lead"))).metadata.purpose, "transactional");
    assert.equal((await emailFor(key("invite", 0, "agent"))).metadata.purpose, "operational");
  });
});
