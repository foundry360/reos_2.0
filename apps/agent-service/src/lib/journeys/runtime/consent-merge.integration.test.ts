/**
 * E.2 consent across contact merges, and the journey email purpose.
 *
 * mergeContacts deletes the losing record, so the survivor must keep every
 * opt-out either record had: SMS/DM opt-out (opted_out) and email unsubscribe
 * (email_unsubscribed_at, the earliest). Each case is checked against the real
 * outbound paths afterwards: deliverMessageToContact (SMS), the live journey
 * send_email step (marketing), and the CRM compose check (conversational).
 *
 * Supabase is PGlite behind the PostgREST bridge with the real migrations 064
 * and 065; Telnyx and Resend are recorded fakes. live-actions-test-env.ts must
 * be the first import; it fails closed on any other network access.
 */

import { attachTestDb, blockedRequests, LIVE_ACTIONS_SCHEMA, providers } from "./live-actions-test-env.ts";

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, afterEach, beforeEach, describe, it } from "node:test";
import type { ActionConfig } from "./contracts.ts";
import type { ActionInput } from "./engine.ts";
import { createTestDb } from "./lead-status-test-db.ts";

/** The rest of the contact columns mergeContacts reads. */
const MERGE_COLUMNS = `
alter table public.contacts
  add column if not exists lead_temperature text,
  add column if not exists ai_summary text,
  add column if not exists agent_brief text,
  add column if not exists recommended_next_action text,
  add column if not exists qualification_score integer,
  add column if not exists target_location text,
  add column if not exists property_type text,
  add column if not exists budget text,
  add column if not exists timeline text,
  add column if not exists financing_status text,
  add column if not exists must_haves text,
  add column if not exists motivation text,
  add column if not exists preferences text,
  add column if not exists created_at timestamptz not null default now();
`;

const db = await createTestDb({ schema: `${LIVE_ACTIONS_SCHEMA}\n${MERGE_COLUMNS}`, rangeFilters: true });
attachTestDb(db);
const { mergeContacts, reconcileContactByEmailOrPhone } = await import("../../db/contact-merge.ts");
const { deliverMessageToContact } = await import("../../messaging/deliver-message.ts");
const { createLiveActionExecutor } = await import("./live-actions.ts");
const { manualEmailUnsubscribeBlock } = await import("../../email/unsubscribe.ts");

const service = db.client("service_role");
const executor = createLiveActionExecutor(service);
const AGENT = randomUUID();
const EMAIL_STEP = { action: "send_email", subject: "Hi {{first_name}}", body: "Hello" } as const;
const EARLY = "2026-09-01T10:00:00.000Z";
const LATE = "2026-09-20T10:00:00.000Z";

let tenant: string;

after(async () => {
  await db.pg.close();
});

beforeEach(async () => {
  await db.reset();
  providers.reset();
  [{ id: tenant }] = await db.query<{ id: string }>("insert into public.tenants default values returning id");
  await db.query("insert into public.tenant_phone_numbers (tenant_id, phone_e164, is_primary) values ($1, '+15559990000', true)", [tenant]);
  await db.query("insert into public.memberships (tenant_id, user_id, role) values ($1, $2, 'member') on conflict do nothing", [tenant, AGENT]);
  await db.query("insert into public.profiles (id, display_name, reply_to_email) values ($1, 'Jordan Agent', 'jordan@agency.test') on conflict do nothing", [AGENT]);
  db.authUsers.set(AGENT, { email: "jordan.login@agency.test" });
});

afterEach(() => {
  assert.deepEqual(blockedRequests, [], "no request may leave the test environment");
});

async function newContact(fields: { opted_out?: boolean; email_unsubscribed_at?: string | null; email?: string; phone?: string } = {}) {
  const [{ id }] = await db.query<{ id: string }>(
    `insert into public.contacts (tenant_id, first_name, email, assigned_agent_id, opted_out, email_unsubscribed_at)
     values ($1, 'Ana', $2, $3, $4, $5) returning id`,
    [tenant, fields.email ?? "ana@example.com", AGENT, fields.opted_out ?? false, fields.email_unsubscribed_at ?? null],
  );
  await db.query("insert into public.contact_identities (contact_id, channel, external_id) values ($1, 'sms', $2)", [
    id,
    fields.phone ?? `+1555${String(Math.floor(Math.random() * 1e7)).padStart(7, "0")}`,
  ]);
  return id;
}

async function consent(contactId: string) {
  const [row] = await db.query<{ opted_out: boolean; email_unsubscribed_at: Date | null }>(
    "select opted_out, email_unsubscribed_at from public.contacts where id = $1",
    [contactId],
  );
  return row ? { opted_out: row.opted_out, email_unsubscribed_at: row.email_unsubscribed_at?.toISOString() ?? null } : null;
}

async function inputFor(contactId: string): Promise<ActionInput> {
  const [lead] = await db.query<Record<string, unknown>>("select * from public.contacts where id = $1", [contactId]);
  return { tenantId: tenant, runId: randomUUID(), nodeId: "node", contactId, lead, opportunity: null };
}

/** SMS to the contact: blocked by an SMS opt-out. */
async function assertSmsBlocked(contactId: string) {
  const sent = await deliverMessageToContact(service, { tenantId: tenant, contactId, channel: "sms", body: "Hi Ana" });
  assert.equal(sent.ok, false);
  assert.match(sent.ok ? "" : sent.error, /opted out/i);
  assert.equal(providers.telnyx.calls.length, 0);
}

/** Journey (marketing) and CRM compose (conversational) email: blocked by an email unsubscribe. */
async function assertEmailBlocked(contactId: string) {
  const journey = await executor.execute(EMAIL_STEP, await inputFor(contactId));
  assert.equal(journey.status, "skipped");
  assert.equal((journey as { reason?: string }).reason, "unsubscribed");
  const compose = await manualEmailUnsubscribeBlock(service, { tenantId: tenant, contactId, emails: ["ana@example.com"] });
  assert.equal(compose.blocked, true);
  assert.equal(providers.resend.calls.length, 0);
}

describe("merging contacts keeps every opt-out", () => {
  it("SMS opt-out on the losing record: the survivor is opted out and SMS is blocked", async () => {
    const winner = await newContact();
    const loser = await newContact({ opted_out: true });

    assert.equal(await mergeContacts(winner, loser), winner);

    assert.equal(await consent(loser), null, "the loser is gone");
    assert.deepEqual(await consent(winner), { opted_out: true, email_unsubscribed_at: null });
    await assertSmsBlocked(winner);
  });

  it("SMS opt-out on the surviving record: it stays opted out and SMS is blocked", async () => {
    const winner = await newContact({ opted_out: true });
    const loser = await newContact();

    assert.equal(await mergeContacts(winner, loser), winner);

    assert.deepEqual(await consent(winner), { opted_out: true, email_unsubscribed_at: null });
    await assertSmsBlocked(winner);
  });

  it("email unsubscribe on the losing record: the survivor is unsubscribed and email is blocked", async () => {
    const winner = await newContact();
    const loser = await newContact({ email_unsubscribed_at: EARLY });

    assert.equal(await mergeContacts(winner, loser), winner);

    assert.deepEqual(await consent(winner), { opted_out: false, email_unsubscribed_at: EARLY });
    await assertEmailBlocked(winner);
  });

  it("email unsubscribe on the surviving record: it stays unsubscribed and email is blocked", async () => {
    const winner = await newContact({ email_unsubscribed_at: EARLY });
    const loser = await newContact();

    assert.equal(await mergeContacts(winner, loser), winner);

    assert.deepEqual(await consent(winner), { opted_out: false, email_unsubscribed_at: EARLY });
    await assertEmailBlocked(winner);
  });

  it("both unsubscribed: the earliest unsubscribe is kept, in either order", async () => {
    const first = await newContact({ email_unsubscribed_at: LATE });
    const second = await newContact({ email_unsubscribed_at: EARLY });
    await mergeContacts(first, second);
    assert.equal((await consent(first))?.email_unsubscribed_at, EARLY);

    const third = await newContact({ email_unsubscribed_at: EARLY, email: "b@example.com" });
    const fourth = await newContact({ email_unsubscribed_at: LATE, email: "b@example.com" });
    await mergeContacts(third, fourth);
    assert.equal((await consent(third))?.email_unsubscribed_at, EARLY);
  });

  it("both opt-outs on different records combine on the survivor", async () => {
    const winner = await newContact({ email_unsubscribed_at: EARLY });
    const loser = await newContact({ opted_out: true });

    await mergeContacts(winner, loser);

    assert.deepEqual(await consent(winner), { opted_out: true, email_unsubscribed_at: EARLY });
    await assertSmsBlocked(winner);
    await assertEmailBlocked(winner);
  });

  it("neither opted out: the survivor stays reachable", async () => {
    const winner = await newContact();
    const loser = await newContact();
    await mergeContacts(winner, loser);
    assert.deepEqual(await consent(winner), { opted_out: false, email_unsubscribed_at: null });
  });

  it("when the opt-out can't be saved on the survivor, the merge doesn't happen", async () => {
    const winner = await newContact();
    const loser = await newContact({ opted_out: true, email_unsubscribed_at: EARLY });

    await db.query("revoke update on public.contacts from service_role");
    let merged: string | null;
    try {
      merged = await mergeContacts(winner, loser);
    } finally {
      await db.query("grant update on public.contacts to service_role");
    }

    assert.equal(merged, null);
    assert.deepEqual(await consent(loser), { opted_out: true, email_unsubscribed_at: EARLY }, "the loser and its opt-outs remain");
    assert.equal((await db.query("select id from public.contact_identities where contact_id = $1", [loser])).length, 1);
  });

  it("through reconciliation by email (the real caller), whichever record wins", async () => {
    const optedOut = await newContact({ opted_out: true, email_unsubscribed_at: EARLY, email: "same@example.com" });
    const reachable = await newContact({ email: "same@example.com" });

    const survivor = await reconcileContactByEmailOrPhone(reachable, { email: "same@example.com" });

    assert.ok(survivor === optedOut || survivor === reachable);
    assert.equal((await db.query("select id from public.contacts")).length, 1);
    assert.deepEqual(await consent(survivor), { opted_out: true, email_unsubscribed_at: EARLY });
    await assertSmsBlocked(survivor);
    await assertEmailBlocked(survivor);
  });
});

describe("journey email purpose is fixed by the operation", () => {
  it("a journey step can't declare itself transactional to reach an unsubscribed contact", async () => {
    const contact = await newContact({ email_unsubscribed_at: EARLY });
    const step = { ...EMAIL_STEP, purpose: "transactional" } as unknown as ActionConfig;

    const result = await executor.execute(step as Exclude<ActionConfig, { action: "wait" }>, await inputFor(contact));

    assert.equal(result.status, "skipped");
    assert.equal((result as { reason?: string }).reason, "unsubscribed");
    assert.equal(providers.resend.calls.length, 0);
  });

  it("a journey email is recorded as marketing", async () => {
    const contact = await newContact();
    const result = await executor.execute(EMAIL_STEP, await inputFor(contact));
    assert.equal(result.status, "completed");
    const [row] = await db.query<{ metadata: Record<string, unknown> }>("select metadata from public.crm_emails");
    assert.equal(row.metadata.purpose, "marketing");
  });
});
