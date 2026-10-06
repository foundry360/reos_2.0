/**
 * E.3a appointment email operator truth: an invite, reschedule or cancellation
 * email that isn't confirmed sent becomes an activity on the person and a
 * system notification to the assigned agent, in communication-truth terms
 * (Not sent / Not confirmed / cancellation not sent because the invite was
 * never confirmed), not only a server warning.
 *
 * The real sendAppointmentInvites / sendAppointmentCancellation, outbound email
 * record, activity log and notifications run unmodified; Supabase is PGlite
 * behind the PostgREST bridge with the real migrations 060–065, and Resend is a
 * recorded fake. live-actions-test-env.ts must be the first import; it fails
 * closed on any other network access.
 */

import { attachTestDb, blockedRequests, providers } from "./live-actions-test-env.ts";

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, afterEach, beforeEach, describe, it } from "node:test";
import { createJourneyEventsTestDb } from "./journey-events-test-db.ts";

const db = await createJourneyEventsTestDb(`
create table public.memberships (
  tenant_id uuid not null references public.tenants (id) on delete cascade,
  user_id uuid not null,
  role text not null default 'member',
  created_at timestamptz not null default now(),
  primary key (tenant_id, user_id)
);

create table public.user_notifications (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null,
  tenant_id uuid not null references public.tenants (id) on delete cascade,
  category text not null,
  title text not null,
  body text,
  href text,
  created_at timestamptz not null default now()
);

create table public.notification_preferences (
  user_id uuid primary key,
  tasks_in_app boolean not null default true,
  leads_in_app boolean not null default true,
  opportunities_in_app boolean not null default true,
  messages_in_app boolean not null default true,
  system_in_app boolean not null default true
);
`);
attachTestDb(db);
const { sendAppointmentInvites, sendAppointmentCancellation, appointmentEmailKey } = await import("../../calendar/appointment-invites.ts");

const START = new Date("2026-10-08T22:00:00.000Z");
const END = new Date("2026-10-08T22:30:00.000Z");
const LABEL = "Thu, Oct 8 at 3:00 PM";
const LEAD_EMAIL = "ana@example.com";
const AGENT_EMAIL = "agent@broker.test";
const AGENT = randomUUID();

let tenant: string;
let lead: string;
let appointment: string;

after(async () => {
  await db.pg.close();
});

beforeEach(async () => {
  await db.reset();
  providers.reset();
  [{ id: tenant }] = await db.query<{ id: string }>("insert into public.tenants default values returning id");
  await db.query("insert into public.memberships (tenant_id, user_id, role) values ($1, $2, 'member')", [tenant, AGENT]);
  [{ id: lead }] = await db.query<{ id: string }>(
    "insert into public.contacts (tenant_id, first_name, last_name, email, assigned_agent_id) values ($1, 'Ana', 'Lima', $2, $3) returning id",
    [tenant, LEAD_EMAIL, AGENT],
  );
  [{ id: appointment }] = await db.query<{ id: string }>(
    `insert into public.contact_activities (tenant_id, contact_id, activity_type, title, occurred_at, ends_at, source)
     values ($1, $2, 'appointment', 'Consult', $3, $4, 'manual') returning id`,
    [tenant, lead, START.toISOString(), END.toISOString()],
  );
});

afterEach(() => {
  assert.deepEqual(blockedRequests, [], "no request may leave the test environment");
});

// ---------- Seed and read helpers (direct SQL, outside the code under test) ----------

async function seedInvite(role: "lead" | "agent", status: string) {
  await db.query(
    `insert into public.crm_emails (tenant_id, contact_id, provider, thread_id, direction, from_email, to_recipients, subject, status, idempotency_key, metadata)
     values ($1, $2, 'resend', $3, 'outbound', 'noreply@reos.test', $4, 'Calendar invite: Consult', $5, $6, $7)`,
    [
      tenant,
      role === "lead" ? lead : null,
      `appointment:${appointment}`,
      JSON.stringify([{ email: role === "lead" ? LEAD_EMAIL : AGENT_EMAIL, name: null }]),
      status,
      appointmentEmailKey(appointment, "invite", 0, role),
      JSON.stringify({ appointment_id: appointment, appointment_notification: "invite", recipient_role: role, sequence: 0, organizer_email: AGENT_EMAIL }),
    ],
  );
}

type Issue = { title: string; body: string };

function issueActivities(): Promise<(Issue & { contact_id: string })[]> {
  return db.query("select contact_id, title, body from public.contact_activities where activity_type = 'email' order by occurred_at");
}

function notifications(): Promise<(Issue & { user_id: string; tenant_id: string; category: string; href: string })[]> {
  return db.query("select user_id, tenant_id, category, title, body, href from public.user_notifications order by created_at");
}

/** Exactly one activity on the lead and one system notification to the assigned agent, saying the same thing. */
async function reported(): Promise<Issue> {
  const activities = await issueActivities();
  assert.equal(activities.length, 1, "one activity on the person");
  assert.equal(activities[0].contact_id, lead);
  const notified = await notifications();
  assert.equal(notified.length, 1, "one notification");
  assert.deepEqual(
    { user: notified[0].user_id, tenant: notified[0].tenant_id, category: notified[0].category, href: notified[0].href },
    { user: AGENT, tenant, category: "system", href: `/leads/${lead}` },
  );
  assert.equal(notified[0].title, activities[0].title);
  assert.equal(notified[0].body, activities[0].body);
  for (const text of [activities[0].title, activities[0].body]) {
    assert.doesNotMatch(text, /@/, "no email addresses");
    assert.doesNotMatch(text, /validation_error|Invalid `to`|timed out|503/i, "no raw provider errors");
  }
  return activities[0];
}

async function nothingReported() {
  assert.deepEqual(await issueActivities(), []);
  assert.deepEqual(await notifications(), []);
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

function cancel(sequence = 1) {
  return sendAppointmentCancellation({ tenantId: tenant, appointmentId: appointment, summary: "Consult", label: LABEL, start: START, end: END, sequence, metadata: {} });
}

async function withoutPrivilege<T>(table: string, privilege: "insert", work: () => Promise<T>): Promise<T> {
  await db.query(`revoke ${privilege} on public.${table} from service_role`);
  try {
    return await work();
  } finally {
    await db.query(`grant ${privilege} on public.${table} to service_role`);
  }
}

// ---------- Tests ----------

describe("appointment email issues reach the operator", () => {
  it("invites that both go out report nothing", async () => {
    const result = await invite();
    assert.equal(result.leadSent && result.agentSent, true);
    await nothingReported();
  });

  it("an invite the provider rejected is reported as Not sent", async () => {
    providers.resend.respondNext(422, { name: "validation_error", message: "Invalid `to` field." });
    const result = await invite();
    assert.equal(result.leadSent, false);
    assert.equal(result.agentSent, true);
    const issue = await reported();
    assert.equal(issue.title, "Calendar invite not sent");
    assert.match(issue.body, /^Consult · Thu, Oct 8 at 3:00 PM$/m);
    assert.match(issue.body, /^Not sent to the lead: the calendar invite email didn't go out\. Let them know directly\.$/m);
    assert.doesNotMatch(issue.body, /agent/);
  });

  it("an invite whose outcome is unknown is reported as Not confirmed", async () => {
    providers.resend.throwNext(timeout());
    await invite();
    const issue = await reported();
    assert.equal(issue.title, "Calendar invite not confirmed");
    assert.match(issue.body, /^Not confirmed for the lead: the calendar invite email may or may not have arrived\. Check with them before sending it again\.$/m);
    assert.doesNotMatch(issue.body, /Not sent/);
  });

  it("an earlier invite still unconfirmed (not sent again) is reported as Not confirmed", async () => {
    await seedInvite("lead", "pending");
    await invite();
    assert.equal(providers.resend.calls.length, 1, "only the agent's copy was sent");
    assert.equal((await reported()).title, "Calendar invite not confirmed");
  });

  it("one person not sent and the other not confirmed reads needs attention, with both lines", async () => {
    providers.resend.respondNext(422, { name: "validation_error", message: "Invalid `to` field." });
    providers.resend.throwNext(timeout());
    await invite();
    const issue = await reported();
    assert.equal(issue.title, "Calendar invite needs attention");
    assert.match(issue.body, /^Not sent to the lead: /m);
    assert.match(issue.body, /^Not confirmed for the agent: the calendar invite email may or may not have arrived\.$/m);
  });

  it("a reschedule notice the provider didn't confirm is reported as such", async () => {
    providers.resend.respondNext(503, { message: "Service unavailable" });
    await invite({ update: { sequence: 1, previousLabel: LABEL } });
    const issue = await reported();
    assert.equal(issue.title, "Reschedule notice not confirmed");
    assert.match(issue.body, /reschedule notice email/);
  });

  it("an explicit agent on the invite is the one notified", async () => {
    const other = randomUUID();
    await db.query("insert into public.memberships (tenant_id, user_id, role) values ($1, $2, 'member')", [tenant, other]);
    providers.resend.respondNext(422, { name: "validation_error", message: "Invalid `to` field." });
    await invite({ agentUserId: other });
    const notified = await notifications();
    assert.deepEqual(notified.map((row) => row.user_id), [other]);
  });

  it("a cancellation withheld because the invite was never confirmed is reported", async () => {
    await seedInvite("lead", "unknown");
    await seedInvite("agent", "sent");
    const result = await cancel();
    assert.equal(result.leadSent, false);
    assert.equal(result.agentSent, true);
    const issue = await reported();
    assert.equal(issue.title, "Cancellation not sent: invite not confirmed");
    assert.match(issue.body, /^Cancellation not sent to the lead because the invite was never confirmed\. Let them know directly\.$/m);
  });

  it("a cancellation withheld from everyone (no cancellation sent at all) is still reported", async () => {
    await seedInvite("lead", "pending");
    await seedInvite("agent", "unknown");
    const result = await cancel();
    assert.equal(result.inviteSent, false);
    assert.equal(providers.resend.calls.length, 0);
    const issue = await reported();
    assert.equal(issue.title, "Cancellation not sent: invite not confirmed");
    assert.match(issue.body, /^Cancellation not sent to the agent because the invite was never confirmed\.$/m);
  });

  it("a cancellation email the provider rejected is reported as Not sent", async () => {
    await seedInvite("lead", "sent");
    providers.resend.respondNext(422, { name: "validation_error", message: "Invalid `to` field." });
    await cancel();
    const issue = await reported();
    assert.equal(issue.title, "Cancellation not sent");
    assert.match(issue.body, /^Not sent to the lead: the cancellation email didn't go out\. Let them know directly\.$/m);
  });

  it("an invite never sent (failed) gets no cancellation and no report", async () => {
    await seedInvite("lead", "failed");
    await cancel();
    assert.equal(providers.resend.calls.length, 0);
    await nothingReported();
  });

  it("a report that can't be written never changes the appointment outcome", async () => {
    providers.resend.respondNext(422, { name: "validation_error", message: "Invalid `to` field." });
    const result = await withoutPrivilege("contact_activities", "insert", () =>
      withoutPrivilege("user_notifications", "insert", () => invite()),
    );
    assert.deepEqual({ lead: result.leadSent, agent: result.agentSent }, { lead: false, agent: true });
    assert.equal(result.errors.length, 1);
  });

  it("the server's error strings are unchanged", async () => {
    providers.resend.respondNext(422, { name: "validation_error", message: "Invalid `to` field." });
    const result = await invite();
    assert.equal(result.errors.length, 1);
    assert.match(result.errors[0], /^Lead: /);
  });
});
