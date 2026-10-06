/**
 * E.3d "Email sent" activity invariant: every outbound email that reaches sent
 * and should carry the activity (Journey and compose email to a contact) ends
 * up with exactly one, whichever path settles it and whatever fails between;
 * appointment, failed, unknown and pending email never get one.
 *
 * - Moving to sent marks the activity owed in the same statement (migration 067 trigger).
 * - ensure_email_sent_activity writes it under the row lock, keyed by the email id
 *   (contact_activities.source_email_id is unique), and clears the flag.
 * - repair_email_sent_activities writes owed activities in bounded batches.
 *
 * Real send paths, webhook handler, sweeper and repair run on PGlite behind the
 * PostgREST bridge; Resend is a recorded fake. Activity-write failures are
 * injected with a trigger. live-actions-test-env.ts must be the first import.
 */

import {
  attachTestDb,
  blockedRequests,
  LIVE_ACTIONS_SCHEMA,
  providers,
  resendRecords,
} from "./live-actions-test-env.ts";

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, afterEach, beforeEach, describe, it } from "node:test";
import type { ActionInput } from "./engine.ts";
import { JourneyStepError } from "./engine.ts";
import { createTestDb } from "./lead-status-test-db.ts";
import { signResendWebhook } from "../../email/resend-webhook-signature.ts";

const db = await createTestDb({
  schema: `${LIVE_ACTIONS_SCHEMA}
alter table public.contact_activities
  add column if not exists ends_at timestamptz,
  add column if not exists source text,
  add column if not exists metadata jsonb;`,
});
attachTestDb(db);
const { createLiveActionExecutor } = await import("./live-actions.ts");
const { sendComposedEmail } = await import("../../email/compose-email.ts");
const { handleResendWebhook } = await import("../../email/email-provider-events.ts");
const { reconcileOutboundEmails } = await import("../../email/email-reconciliation.ts");
const { ensureEmailSentActivity, repairEmailSentActivities } = await import("../../email/email-sent-activity.ts");
const { sendAppointmentInvites } = await import("../../calendar/appointment-invites.ts");
const { clearPlatformSecretCache } = await import("../../admin/platform-secrets.ts");

const service = db.client("service_role");
const executor = createLiveActionExecutor(service);
const SECRET = `whsec_${Buffer.from("e3d-test-webhook-signing-key-0123456789").toString("base64")}`;
const AGENT = randomUUID();
const USER = randomUUID();
const LEAD_EMAIL = "ana@example.com";
const EMAIL_STEP = { action: "send_email", subject: "Hi {{first_name}}", body: "Hello" } as const;
const T0 = Date.parse("2026-10-06T12:00:00.000Z");
const at = (minutes: number) => new Date(T0 + minutes * 60_000).toISOString();

let tenant: string;

/** One-shot hook before a Resend request reaches the fake. */
let atResend: (() => Promise<void>) | null = null;
const environmentFetch = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  if (atResend && url.startsWith("https://api.resend.com/")) {
    const hook = atResend;
    atResend = null;
    await hook();
  }
  return environmentFetch(input, init);
};

after(async () => {
  globalThis.fetch = environmentFetch;
  await db.pg.close();
});

beforeEach(async () => {
  await db.reset();
  providers.reset();
  clearPlatformSecretCache();
  atResend = null;
  tenant = await newTenant();
});

afterEach(() => {
  assert.deepEqual(blockedRequests, [], "no request may leave the test environment");
});

// ---------- Helpers (direct SQL, outside the code under test) ----------

async function newTenant(): Promise<string> {
  const [{ id }] = await db.query<{ id: string }>("insert into public.tenants default values returning id");
  await db.query("insert into public.memberships (tenant_id, user_id, role) values ($1, $2, 'member')", [id, AGENT]);
  await db.query(
    "insert into public.profiles (id, display_name, reply_to_email) values ($1, 'Jordan Agent', 'jordan@agency.test') on conflict do nothing",
    [AGENT],
  );
  db.authUsers.set(AGENT, { email: "jordan.login@agency.test" });
  return id;
}

async function newLead(tenantId = tenant): Promise<string> {
  const [{ id }] = await db.query<{ id: string }>(
    `insert into public.contacts (tenant_id, first_name, last_name, email, assigned_agent_id)
     values ($1, 'Ana', 'Lima', $2, $3) returning id`,
    [tenantId, LEAD_EMAIL, AGENT],
  );
  return id;
}

async function seedEmail(fields: {
  status: string;
  contactId: string | null;
  providerMessageId?: string | null;
  purpose?: string;
  tenantId?: string;
}): Promise<string> {
  const [{ id }] = await db.query<{ id: string }>(
    `insert into public.crm_emails (tenant_id, contact_id, provider, provider_message_id, thread_id, direction, from_email,
       to_recipients, subject, snippet, status, idempotency_key, metadata)
     values ($1, $2, 'resend', $3, 'thread-seed', 'outbound', 'journeys@reos.test', $4, 'Seeded email', 'Seeded body', $5, $6, $7)
     returning id`,
    [
      fields.tenantId ?? tenant,
      fields.contactId,
      fields.providerMessageId ?? null,
      JSON.stringify([{ email: LEAD_EMAIL, name: null }]),
      fields.status,
      `seed:${randomUUID()}`,
      JSON.stringify({ purpose: fields.purpose ?? "marketing" }),
    ],
  );
  return id;
}

/** A sent email whose activity is still owed, as a crash after the send left it. */
async function owedEmail(contactId: string, tenantId = tenant): Promise<string> {
  const id = await seedEmail({ status: "pending", contactId, tenantId });
  await db.query("update public.crm_emails set status = 'sent', sent_at = now() where id = $1", [id]);
  return id;
}

interface EmailRow {
  id: string;
  tenant_id: string;
  status: string;
  provider_message_id: string | null;
  sent_activity_owed: boolean;
  metadata: Record<string, unknown>;
}

async function email(id: string): Promise<EmailRow> {
  const [row] = await db.query<EmailRow>("select * from public.crm_emails where id = $1", [id]);
  assert.ok(row, "the email record exists");
  return row;
}

async function onlyEmail(): Promise<EmailRow> {
  const rows = await db.query<EmailRow>("select * from public.crm_emails");
  assert.equal(rows.length, 1, "exactly one email record");
  return rows[0];
}

interface ActivityRow {
  title: string;
  body: string | null;
  source_email_id: string | null;
  related_entity_type: string | null;
}

function sentActivities(contactId: string): Promise<ActivityRow[]> {
  return db.query<ActivityRow>(
    "select title, body, source_email_id, related_entity_type from public.contact_activities where contact_id = $1 and title like 'Email sent:%'",
    [contactId],
  );
}

async function allSentActivities(): Promise<number> {
  const [{ count }] = await db.query<{ count: number }>(
    "select count(*)::int as count from public.contact_activities where title like 'Email sent:%'",
  );
  return count;
}

/** Every "Email sent" activity insert fails while `work` runs. */
async function withActivityFailure<T>(work: () => Promise<T>): Promise<T> {
  await db.pg.exec(`
    create or replace function public.test_fail_sent_activity() returns trigger language plpgsql as $$
    begin
      if new.title like 'Email sent:%' then raise exception 'injected activity failure'; end if;
      return new;
    end $$;
    create trigger test_fail_sent_activity before insert on public.contact_activities
      for each row execute function public.test_fail_sent_activity();`);
  try {
    return await work();
  } finally {
    await db.query("drop trigger test_fail_sent_activity on public.contact_activities");
  }
}

/** console.error lines written while `work` runs. */
async function capturingErrors<T>(work: () => Promise<T>): Promise<{ result: T; errors: string[] }> {
  const errors: string[] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => {
    errors.push(args.map(String).join(" "));
  };
  try {
    return { result: await work(), errors };
  } finally {
    console.error = original;
  }
}

async function makeDue(id: string) {
  await db.query("update public.crm_emails set reconcile_after = now() - interval '1 second' where id = $1", [id]);
}

let eventSequence = 0;

async function deliver(type: string, fields: { reosEmailId: string; providerMessageId?: string | null; at?: string; eventId?: string }) {
  const eventId = fields.eventId ?? `msg_${++eventSequence}`;
  const body = JSON.stringify({
    type,
    created_at: fields.at ?? new Date().toISOString(),
    data: { email_id: fields.providerMessageId ?? null, tags: { reos_email_id: fields.reosEmailId } },
  });
  const timestamp = String(Math.floor(Date.now() / 1000));
  const response = await handleResendWebhook({
    secret: SECRET,
    headers: new Headers({
      "svix-id": eventId,
      "svix-timestamp": timestamp,
      "svix-signature": `v1,${signResendWebhook(SECRET, eventId, timestamp, body)}`,
    }),
    rawBody: body,
  });
  assert.equal(response.status, 200);
  return response;
}

async function inputFor(contactId: string, runId = randomUUID()): Promise<ActionInput> {
  const [lead] = await db.query<Record<string, unknown>>("select * from public.contacts where id = $1", [contactId]);
  return { tenantId: tenant, runId, nodeId: "a1", contactId, lead, opportunity: null };
}

async function withoutPrivilege<T>(table: string, privilege: "insert" | "update", work: () => Promise<T>): Promise<T> {
  await db.query(`revoke ${privilege} on public.${table} from service_role`);
  try {
    return await work();
  } finally {
    await db.query(`grant ${privilege} on public.${table} to service_role`);
  }
}

function compose(contactId: string, draftId = randomUUID()) {
  return sendComposedEmail(service, {
    tenantId: tenant,
    userId: USER,
    draftId,
    contactId,
    opportunityId: null,
    to: [{ email: LEAD_EMAIL, name: "Ana Lima" }],
    cc: [],
    subject: "Following up",
    bodyHtml: "<p>Hi Ana</p>",
    threadId: null,
    replyTo: "jordan@agency.test",
    agentName: "Jordan Agent",
  });
}

const timeout = () => Object.assign(new Error("The operation was aborted due to timeout"), { name: "TimeoutError" });

// ---------- Send paths ----------

describe("send paths: one activity per sent email, keyed by the email", () => {
  it("a sent Journey email has exactly one activity naming it (1)", async () => {
    const lead = await newLead();
    await executor.execute(EMAIL_STEP, await inputFor(lead));
    const row = await onlyEmail();
    assert.equal(row.status, "sent");
    assert.equal(row.sent_activity_owed, false);
    const [{ snippet }] = await db.query<{ snippet: string }>("select snippet from public.crm_emails where id = $1", [row.id]);
    assert.match(snippet, /^Hello/);
    assert.deepEqual(await sentActivities(lead), [
      { title: "Email sent: Hi Ana", body: snippet, source_email_id: row.id, related_entity_type: null },
    ]);
  });

  it("a sent compose email has exactly one activity naming it (2)", async () => {
    const lead = await newLead();
    assert.equal((await compose(lead)).outcome, "sent");
    const row = await onlyEmail();
    assert.equal(row.sent_activity_owed, false);
    const activities = await sentActivities(lead);
    assert.deepEqual(activities.map((activity) => [activity.title, activity.source_email_id]), [["Email sent: Following up", row.id]]);
  });

  it("a failed email has no activity, and its successful retry has exactly one (3)", async () => {
    const lead = await newLead();
    const input = await inputFor(lead);
    providers.resend.respondNext(422, { name: "validation_error", message: "Invalid `to` field." });
    await assert.rejects(executor.execute(EMAIL_STEP, input), (error: unknown) => error instanceof JourneyStepError && error.kind === "transient");
    const failed = await onlyEmail();
    assert.deepEqual([failed.status, failed.sent_activity_owed], ["failed", false]);
    assert.equal((await sentActivities(lead)).length, 0);

    await executor.execute(EMAIL_STEP, input);
    assert.equal((await onlyEmail()).status, "sent");
    assert.equal((await sentActivities(lead)).length, 1);
  });

  it("unknown and pending email have no activity, even after repair (4)", async () => {
    const lead = await newLead();
    providers.resend.throwNext(timeout());
    await assert.rejects(executor.execute(EMAIL_STEP, await inputFor(lead)));
    const otherInput = await inputFor(await newLead());
    await assert.rejects(withoutPrivilege("crm_emails", "update", () => executor.execute(EMAIL_STEP, otherInput)));
    const rows = await db.query<EmailRow>("select * from public.crm_emails order by status");
    assert.deepEqual(rows.map((row) => [row.status, row.sent_activity_owed]), [["pending", false], ["unknown", false]]);

    await repairEmailSentActivities();
    for (const row of rows) assert.equal(await ensureEmailSentActivity(tenant, row.id), "not_owed");
    assert.equal(await allSentActivities(), 0);
  });
});

// ---------- Webhook and reconciliation ----------

describe("webhook and reconciliation settlement", () => {
  it("webhook settlement writes the activity exactly once (5)", async () => {
    const lead = await newLead();
    const id = await seedEmail({ status: "unknown", contactId: lead });
    await deliver("email.sent", { reosEmailId: id, providerMessageId: "re_w1", at: at(1) });
    await deliver("email.delivered", { reosEmailId: id, providerMessageId: "re_w1", at: at(2) });
    assert.deepEqual((await sentActivities(lead)).map((activity) => activity.source_email_id), [id]);
    assert.equal((await email(id)).sent_activity_owed, false);
  });

  it("reconciliation settlement writes the activity exactly once (6)", async () => {
    const lead = await newLead();
    const id = await seedEmail({ status: "unknown", contactId: lead, providerMessageId: "re_r1" });
    resendRecords.set("re_r1", { lastEvent: "delivered" });
    await makeDue(id);
    await reconcileOutboundEmails();
    await reconcileOutboundEmails();
    assert.equal((await email(id)).status, "sent");
    assert.deepEqual((await sentActivities(lead)).map((activity) => activity.source_email_id), [id]);
  });

  it("send then webhook: no second activity (10)", async () => {
    const lead = await newLead();
    await executor.execute(EMAIL_STEP, await inputFor(lead));
    const row = await onlyEmail();
    await deliver("email.sent", { reosEmailId: row.id, providerMessageId: row.provider_message_id, at: at(1) });
    await deliver("email.delivered", { reosEmailId: row.id, providerMessageId: row.provider_message_id, at: at(2) });
    assert.equal((await sentActivities(lead)).length, 1);
  });

  it("webhook then reconciliation of the same email: one activity (11)", async () => {
    const lead = await newLead();
    const id = await seedEmail({ status: "unknown", contactId: lead, providerMessageId: "re_wr" });
    resendRecords.set("re_wr", { lastEvent: "delivered" });
    await makeDue(id);
    atResend = async () => {
      await deliver("email.sent", { reosEmailId: id, providerMessageId: "re_wr", at: at(1) });
    };
    const summary = await reconcileOutboundEmails();
    assert.equal(summary?.claimed, 1);
    assert.equal(providers.resendRetrieve.calls.length, 1, "reconciliation looked the same email up after the webhook settled it");
    assert.equal((await sentActivities(lead)).length, 1);
  });

  it("a duplicate webhook cannot duplicate the activity (13)", async () => {
    const lead = await newLead();
    const id = await seedEmail({ status: "pending", contactId: lead });
    const event = { reosEmailId: id, providerMessageId: "re_dup", at: at(1), eventId: "msg_same" };
    await Promise.all([deliver("email.sent", event), deliver("email.sent", event)]);
    await deliver("email.sent", event);
    assert.equal((await sentActivities(lead)).length, 1);
  });

  it("later bounce, complaint, delay, open and click events add no activity", async () => {
    const lead = await newLead();
    const id = await seedEmail({ status: "pending", contactId: lead });
    await deliver("email.sent", { reosEmailId: id, providerMessageId: "re_late", at: at(1) });
    for (const [index, type] of ["email.delivery_delayed", "email.bounced", "email.complained", "email.opened", "email.clicked"].entries()) {
      await deliver(type, { reosEmailId: id, providerMessageId: "re_late", at: at(2 + index) });
    }
    assert.equal((await sentActivities(lead)).length, 1);
  });
});

// ---------- Failure and repair ----------

describe("activity-write failure and repair", () => {
  it("a failed activity write after a send is logged and leaves the email owed; the send is still sent (7)", async () => {
    const lead = await newLead();
    const input = await inputFor(lead);
    const { result, errors } = await capturingErrors(() => withActivityFailure(() => executor.execute(EMAIL_STEP, input)));
    assert.equal((result.output as Record<string, unknown>).sent, true);
    const row = await onlyEmail();
    assert.deepEqual([row.status, row.sent_activity_owed], ["sent", true], "the owed activity is durably recorded");
    assert.equal((await sentActivities(lead)).length, 0);
    assert.ok(errors.some((line) => /Email sent activity not written/.test(line)), "the failure is reported, not swallowed");
  });

  it("repair writes the missing activity; running it again writes nothing more (8, 9)", async () => {
    const lead = await newLead();
    await withActivityFailure(async () => executor.execute(EMAIL_STEP, await inputFor(lead)));
    const row = await onlyEmail();
    assert.equal(row.sent_activity_owed, true);

    const first = await repairEmailSentActivities();
    assert.deepEqual(first, { checked: 1, created: 1, existing: 0, notOwed: 0, failed: 0, errors: 0 });
    assert.deepEqual((await sentActivities(lead)).map((activity) => activity.source_email_id), [row.id]);
    assert.equal((await email(row.id)).sent_activity_owed, false);

    const second = await repairEmailSentActivities();
    assert.equal(second?.checked, 0);
    assert.equal((await sentActivities(lead)).length, 1);
    assert.equal(providers.resend.calls.length, 1, "repair never sends");
    assert.equal((await email(row.id)).status, "sent", "repair never touches send state");
  });

  it("webhook settles, its activity write fails, repair later writes exactly one", async () => {
    const lead = await newLead();
    const id = await seedEmail({ status: "unknown", contactId: lead });
    await withActivityFailure(() => deliver("email.sent", { reosEmailId: id, providerMessageId: "re_wf", at: at(1) }));
    const settled = await email(id);
    assert.deepEqual([settled.status, settled.sent_activity_owed], ["sent", true], "the settlement stands; the activity is owed");
    assert.equal((await sentActivities(lead)).length, 0);

    await repairEmailSentActivities();
    await repairEmailSentActivities();
    assert.equal((await sentActivities(lead)).length, 1);
  });

  it("a repeat of the send, or a later event, also settles an owed activity once, without resending", async () => {
    const lead = await newLead();
    const input = await inputFor(lead);
    await withActivityFailure(() => executor.execute(EMAIL_STEP, input));
    await executor.execute(EMAIL_STEP, input);
    assert.equal((await sentActivities(lead)).length, 1);
    assert.equal(providers.resend.calls.length, 1);

    const other = await newLead();
    const id = await owedEmail(other);
    await deliver("email.delivered", { reosEmailId: id, at: at(1) });
    await deliver("email.delivered", { reosEmailId: id, at: at(2) });
    assert.equal((await sentActivities(other)).length, 1);
  });

  it("a failing row doesn't stop repair of the others; it stays owed", async () => {
    const leads = [await newLead(), await newLead()];
    const ids = [await owedEmail(leads[0]), await owedEmail(leads[1])];
    await db.query("update public.crm_emails set subject = 'poison' where id = $1", [ids[0]]);
    await db.pg.exec(`
      create function public.test_poison() returns trigger language plpgsql as $$
      begin if new.title = 'Email sent: poison' then raise exception 'poison'; end if; return new; end $$;
      create trigger test_poison before insert on public.contact_activities for each row execute function public.test_poison();`);
    try {
      const summary = await repairEmailSentActivities();
      assert.deepEqual([summary?.created, summary?.failed], [1, 1]);
    } finally {
      await db.pg.exec("drop trigger test_poison on public.contact_activities; drop function public.test_poison();");
    }
    assert.equal((await email(ids[0])).sent_activity_owed, true);
    assert.equal((await sentActivities(leads[1])).length, 1);
    await repairEmailSentActivities();
    assert.equal((await sentActivities(leads[0])).length, 1);
  });

  it("repair is tenant scoped to each email: every tenant's owed activity lands on its own contact", async () => {
    const otherTenant = await newTenant();
    const theirLead = await newLead(otherTenant);
    const ourLead = await newLead();
    const theirs = await owedEmail(theirLead, otherTenant);
    const ours = await owedEmail(ourLead);
    assert.equal(await ensureEmailSentActivity(tenant, theirs), "missing", "another tenant's email isn't reachable");
    await repairEmailSentActivities();
    const [theirActivity] = await db.query<{ tenant_id: string }>("select tenant_id from public.contact_activities where source_email_id = $1", [theirs]);
    const [ourActivity] = await db.query<{ tenant_id: string }>("select tenant_id from public.contact_activities where source_email_id = $1", [ours]);
    assert.equal(theirActivity.tenant_id, otherTenant);
    assert.equal(ourActivity.tenant_id, tenant);
  });

  it("an owed email whose contact was deleted is released without an activity", async () => {
    const lead = await newLead();
    const id = await owedEmail(lead);
    await db.query("delete from public.contacts where id = $1", [lead]);
    assert.equal(await ensureEmailSentActivity(tenant, id), "not_owed");
    assert.equal((await email(id)).sent_activity_owed, false);
  });

  it("the database refuses a second activity for the same email", async () => {
    const lead = await newLead();
    const id = await owedEmail(lead);
    assert.equal(await ensureEmailSentActivity(tenant, id), "created");
    await assert.rejects(
      db.query(
        "insert into public.contact_activities (tenant_id, contact_id, activity_type, title, source_email_id) values ($1, $2, 'email', 'Email sent: again', $3)",
        [tenant, lead, id],
      ),
      /duplicate key|unique/,
    );
  });
});

// ---------- Concurrency ----------

describe("concurrency", () => {
  it("concurrent repairs and ensures write each owed activity once (12)", async () => {
    const lead = await newLead();
    const ids: string[] = [];
    for (let index = 0; index < 20; index += 1) ids.push(await owedEmail(lead));

    const results = await Promise.all([
      repairEmailSentActivities({ batchSize: 7 }),
      repairEmailSentActivities({ batchSize: 7 }),
      repairEmailSentActivities({ batchSize: 7 }),
      ...ids.slice(0, 5).map((id) => ensureEmailSentActivity(tenant, id)),
    ]);

    assert.equal((await sentActivities(lead)).length, 20);
    assert.equal(new Set((await sentActivities(lead)).map((activity) => activity.source_email_id)).size, 20);
    const created = results.reduce<number>(
      (total, result) => total + (typeof result === "string" ? (result === "created" ? 1 : 0) : (result?.created ?? 0)),
      0,
    );
    assert.equal(created, 20);
    const [{ owed }] = await db.query<{ owed: number }>("select count(*)::int as owed from public.crm_emails where sent_activity_owed");
    assert.equal(owed, 0);
  });

  it("a webhook racing reconciliation and repair for one email leaves one activity", async () => {
    const lead = await newLead();
    const id = await seedEmail({ status: "unknown", contactId: lead, providerMessageId: "re_tri" });
    resendRecords.set("re_tri", { lastEvent: "sent" });
    await makeDue(id);
    await Promise.all([
      deliver("email.sent", { reosEmailId: id, providerMessageId: "re_tri", at: at(1) }),
      reconcileOutboundEmails(),
      repairEmailSentActivities(),
      ensureEmailSentActivity(tenant, id),
    ]);
    assert.equal((await email(id)).status, "sent");
    assert.equal((await sentActivities(lead)).length, 1);
  });
});

// ---------- Appointments ----------

describe("appointment email keeps its behavior (14)", () => {
  it("appointment email is never owed an Email sent activity, through send, events and repair", async () => {
    const lead = await newLead();
    const [{ id: appointment }] = await db.query<{ id: string }>(
      `insert into public.contact_activities (tenant_id, contact_id, activity_type, title, occurred_at, ends_at, source)
       values ($1, $2, 'appointment', 'Consult', $3, $4, 'manual') returning id`,
      [tenant, lead, at(60 * 48), at(60 * 48 + 30)],
    );
    providers.resend.throwNext(timeout());
    const result = await sendAppointmentInvites({
      tenantId: tenant,
      appointmentId: appointment,
      summary: "Consult",
      label: "Thu, Oct 8 at 3:00 PM",
      start: new Date(at(60 * 48)),
      end: new Date(at(60 * 48 + 30)),
      lead: { email: LEAD_EMAIL, name: "Ana Lima" },
      agentUserId: null,
      organizerFallback: { email: "agent@broker.test", name: "Jordan Agent" },
    });
    assert.deepEqual([result.leadSent, result.agentSent], [false, true]);
    const rows = await db.query<EmailRow>("select * from public.crm_emails");
    const leadRow = rows.find((row) => row.metadata.recipient_role === "lead");
    assert.ok(leadRow);

    await deliver("email.sent", { reosEmailId: leadRow.id, providerMessageId: "re_appt", at: at(1) });
    await deliver("email.bounced", { reosEmailId: leadRow.id, providerMessageId: "re_appt", at: at(2) });
    const repair = await repairEmailSentActivities();

    assert.equal((await email(leadRow.id)).status, "sent");
    for (const row of await db.query<EmailRow>("select * from public.crm_emails")) {
      assert.equal(row.sent_activity_owed, false);
      assert.equal(await ensureEmailSentActivity(tenant, row.id), "not_owed");
    }
    assert.equal(repair?.checked, 0);
    assert.equal((await sentActivities(lead)).length, 0);
  });
});
