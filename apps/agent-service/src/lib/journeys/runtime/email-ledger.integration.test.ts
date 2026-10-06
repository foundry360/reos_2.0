/**
 * E.3b outbound email ledger: Journey send_email and CRM compose email are
 * recorded in crm_emails as pending, with their thread, before Resend is
 * called, then get Resend's answer (sent / failed / unknown). A pending or
 * unknown email is never resent; a failed one is retried on the same record;
 * when Resend's answer can't be saved the record stays pending, never sent.
 * Compose email is one operation per draft identity, bound to its content.
 *
 * The real live executor, sendComposedEmail, sendLedgeredEmail, outbound email
 * record and Resend sender run unmodified; Supabase is PGlite behind the
 * PostgREST bridge (with the real migrations 064 and 065); Resend is a recorded
 * fake. live-actions-test-env.ts must be the first import; it fails closed on
 * any other network access.
 */

import { attachTestDb, blockedRequests, LIVE_ACTIONS_SCHEMA, providers } from "./live-actions-test-env.ts";

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { after, afterEach, beforeEach, describe, it } from "node:test";
import type { ActionInput, ActionResult } from "./engine.ts";
import { JourneyStepError } from "./engine.ts";
import { createTestDb } from "./lead-status-test-db.ts";
import { composerAfterSend } from "../../messaging/compose-draft.ts";

const db = await createTestDb({ schema: LIVE_ACTIONS_SCHEMA });
attachTestDb(db);
const { createLiveActionExecutor } = await import("./live-actions.ts");
const { sendComposedEmail, composeEmailKey, composeEmailThreadId } = await import("../../email/compose-email.ts");
const { clearPlatformSecretCache } = await import("../../admin/platform-secrets.ts");

const service = db.client("service_role");
const executor = createLiveActionExecutor(service);
const AGENT = randomUUID();
const USER = randomUUID();
const LEAD_EMAIL = "ana@example.com";
const EMAIL_STEP = { action: "send_email", subject: "Hi {{first_name}}", body: "Hello" } as const;

let tenant: string;

/** Runs as each Resend request reaches the fake, to look at the database at that moment. */
let atResend: (() => Promise<void>) | null = null;
const environmentFetch = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  if (atResend && url.startsWith("https://api.resend.com/")) await atResend();
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

// ---------- Seed and read helpers (direct SQL, outside the code under test) ----------

async function newTenant(): Promise<string> {
  const [{ id }] = await db.query<{ id: string }>("insert into public.tenants default values returning id");
  await db.query("insert into public.memberships (tenant_id, user_id, role) values ($1, $2, 'member')", [id, AGENT]);
  await db.query("insert into public.profiles (id, display_name, reply_to_email) values ($1, 'Jordan Agent', 'jordan@agency.test') on conflict do nothing", [AGENT]);
  db.authUsers.set(AGENT, { email: "jordan.login@agency.test" });
  return id;
}

async function newLead(fields: { email?: string; unsubscribed?: boolean; tenantId?: string } = {}): Promise<string> {
  const [{ id }] = await db.query<{ id: string }>(
    `insert into public.contacts (tenant_id, first_name, last_name, email, assigned_agent_id, email_unsubscribed_at)
     values ($1, 'Ana', 'Lima', $2, $3, $4) returning id`,
    [fields.tenantId ?? tenant, fields.email ?? LEAD_EMAIL, AGENT, fields.unsubscribed ? new Date().toISOString() : null],
  );
  return id;
}

interface EmailRow {
  id: string;
  tenant_id: string;
  user_id: string | null;
  contact_id: string | null;
  opportunity_id: string | null;
  provider_message_id: string | null;
  thread_id: string | null;
  to_recipients: { email: string; name: string | null }[];
  cc_recipients: { email: string; name: string | null }[];
  subject: string;
  body_html: string;
  status: string;
  send_error: string | null;
  sent_at: Date | null;
  idempotency_key: string | null;
  metadata: Record<string, unknown>;
}

function emails(): Promise<EmailRow[]> {
  return db.query<EmailRow>("select * from public.crm_emails order by idempotency_key");
}

async function onlyEmail(): Promise<EmailRow> {
  const rows = await emails();
  assert.equal(rows.length, 1, "exactly one email record");
  return rows[0];
}

/** The records as they stand when Resend is called. */
function captureAtResend(): EmailRow[][] {
  const seen: EmailRow[][] = [];
  atResend = async () => {
    seen.push(await emails());
  };
  return seen;
}

async function withoutPrivilege<T>(table: string, privilege: "insert" | "update", work: () => Promise<T>): Promise<T> {
  await db.query(`revoke ${privilege} on public.${table} from service_role`);
  try {
    return await work();
  } finally {
    await db.query(`grant ${privilege} on public.${table} to service_role`);
  }
}

const timeout = () => Object.assign(new Error("The operation was aborted due to timeout"), { name: "TimeoutError" });
const reject422 = () => providers.resend.respondNext(422, { name: "validation_error", message: "Invalid `to` field." });

async function inputFor(contactId: string, runId = randomUUID()): Promise<ActionInput> {
  const [lead] = await db.query<Record<string, unknown>>("select * from public.contacts where id = $1", [contactId]);
  return { tenantId: tenant, runId, nodeId: "a1", contactId, lead, opportunity: null };
}

async function stepFails(promise: Promise<ActionResult>, kind: "config" | "transient", message: RegExp) {
  await assert.rejects(promise, (error: unknown) => {
    assert.ok(error instanceof JourneyStepError, `expected a JourneyStepError, got ${String(error)}`);
    assert.equal(error.kind, kind);
    assert.match(error.message, message);
    return true;
  });
}

type ComposeOverrides = Partial<{
  contactId: string | null;
  opportunityId: string | null;
  to: { email: string; name: string | null }[];
  cc: { email: string; name: string | null }[];
  subject: string;
  bodyHtml: string;
  threadId: string | null;
  userId: string;
  tenantId: string;
}>;

function compose(contactId: string | null, draftId: string, overrides: ComposeOverrides = {}) {
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
    ...overrides,
  });
}

// ---------- Journey send_email ----------

describe("journey email: the record comes first", () => {
  it("a pending record with its thread and marketing purpose exists when Resend is called; then it's sent", async () => {
    const lead = await newLead();
    const input = await inputFor(lead);
    const seen = captureAtResend();
    const result = await executor.execute(EMAIL_STEP, input);

    const key = `journey:${input.runId}:a1`;
    assert.equal(seen.length, 1);
    assert.equal(seen[0].length, 1);
    const pending = seen[0][0];
    assert.deepEqual(
      [pending.status, pending.idempotency_key, pending.thread_id, pending.contact_id, pending.provider_message_id, pending.metadata.purpose],
      ["pending", key, key, lead, null, "marketing"],
    );
    assert.equal(pending.metadata.journey_run_id, input.runId);

    const row = await onlyEmail();
    assert.deepEqual([row.id, row.status, row.provider_message_id, row.thread_id], [pending.id, "sent", "resend-email-1", key]);
    assert.ok(row.sent_at);
    assert.deepEqual(result, {
      status: "completed",
      output: { sent: true, email_id: row.id, provider_message_id: "resend-email-1", to: LEAD_EMAIL, subject: "Hi Ana" },
    });
  });

  it("a repeat of the same step after a send returns the same email without sending again", async () => {
    const lead = await newLead();
    const input = await inputFor(lead);
    const first = await executor.execute(EMAIL_STEP, input);
    const again = await executor.execute(EMAIL_STEP, input);
    assert.equal(providers.resend.calls.length, 1);
    assert.deepEqual(again, first);
    assert.equal((await emails()).length, 1);
  });

  it("a Resend rejection is failed and retryable: the retry claims the same record and sends", async () => {
    const lead = await newLead();
    const input = await inputFor(lead);
    reject422();
    await stepFails(executor.execute(EMAIL_STEP, input), "transient", /Invalid `to` field/);
    const failed = await onlyEmail();
    assert.equal(failed.status, "failed");

    await executor.execute(EMAIL_STEP, input);
    const row = await onlyEmail();
    assert.deepEqual([row.id, row.status], [failed.id, "sent"]);
    assert.equal(providers.resend.calls.length, 2);
    assert.deepEqual(providers.resend.calls.map((call) => call.idempotencyKey), [`journey:${input.runId}:a1`, `journey:${input.runId}:a1`]);
  });

  it("a timeout or 5xx is unknown: the step fails without retry and the email is never resent", async () => {
    for (const fault of [() => providers.resend.throwNext(timeout()), () => providers.resend.respondNext(503, { message: "Unavailable" })]) {
      await db.query("delete from public.crm_emails");
      providers.reset();
      const input = await inputFor(await newLead());
      fault();
      await stepFails(executor.execute(EMAIL_STEP, input), "config", /may have been sent/);
      assert.equal((await onlyEmail()).status, "unknown");
      await stepFails(executor.execute(EMAIL_STEP, input), "config", /wasn't confirmed/);
      assert.equal(providers.resend.calls.length, 1);
    }
  });

  it("when Resend's acceptance can't be saved, the record stays pending (never sent) and a retry doesn't resend", async () => {
    const lead = await newLead();
    const input = await inputFor(lead);
    await withoutPrivilege("crm_emails", "update", () =>
      stepFails(executor.execute(EMAIL_STEP, input), "config", /couldn't record Resend's answer/),
    );
    assert.equal(providers.resend.calls.length, 1, "Resend accepted it");
    const row = await onlyEmail();
    assert.deepEqual([row.status, row.provider_message_id, row.sent_at], ["pending", null, null]);

    await stepFails(executor.execute(EMAIL_STEP, input), "config", /wasn't confirmed/);
    assert.equal(providers.resend.calls.length, 1);
    assert.equal((await onlyEmail()).status, "pending");
  });

  it("when the record can't be written, Resend is never called (transient)", async () => {
    const input = await inputFor(await newLead());
    await withoutPrivilege("crm_emails", "insert", () =>
      stepFails(executor.execute(EMAIL_STEP, input), "transient", /couldn't be recorded, so it wasn't sent/),
    );
    assert.equal(providers.resend.calls.length, 0);
    assert.equal((await emails()).length, 0);
  });

  it("unsubscribe still skips journey email before anything is recorded", async () => {
    const lead = await newLead({ unsubscribed: true });
    const result = await executor.execute(EMAIL_STEP, await inputFor(lead));
    assert.equal(result.status === "skipped" && result.reason, "unsubscribed");
    assert.equal(providers.resend.calls.length, 0);
    assert.equal((await emails()).length, 0);
  });
});

// ---------- CRM compose email ----------

describe("compose email: the record comes first", () => {
  it("a pending record with the draft's key, thread, sender and conversational purpose exists when Resend is called", async () => {
    const lead = await newLead();
    const draft = randomUUID();
    const seen = captureAtResend();
    const result = await compose(lead, draft);

    assert.equal(seen.length, 1);
    const [pending] = seen[0];
    assert.deepEqual(
      [pending.status, pending.idempotency_key, pending.thread_id, pending.user_id, pending.contact_id, pending.metadata.purpose],
      ["pending", composeEmailKey(USER, draft), composeEmailThreadId(draft), USER, lead, "conversational"],
    );
    assert.match(String(pending.metadata.content_hash), /^[0-9a-f]{64}$/);
    assert.equal(pending.metadata.reply_to, "jordan@agency.test");

    const row = await onlyEmail();
    assert.deepEqual(result, { outcome: "sent", messageId: row.id });
    assert.deepEqual([row.id, row.status, row.provider_message_id, row.thread_id], [pending.id, "sent", "resend-email-1", composeEmailThreadId(draft)]);
    const activities = await db.query<{ title: string }>("select title from public.contact_activities where contact_id = $1", [lead]);
    assert.deepEqual(activities.map((activity) => activity.title), ["Email sent: Following up"]);
  });

  it("every recipient, to and cc, is on the record before Resend is called", async () => {
    const lead = await newLead();
    const seen = captureAtResend();
    const cc = [{ email: "partner@example.com", name: "Sam Lima" }];
    await compose(lead, randomUUID(), { cc });
    assert.deepEqual(seen[0][0].to_recipients, [{ email: LEAD_EMAIL, name: "Ana Lima" }]);
    assert.deepEqual(seen[0][0].cc_recipients, cc);
    assert.deepEqual((await onlyEmail()).cc_recipients, cc);
  });

  it("a reply keeps the thread it answers; the record carries it before Resend is called", async () => {
    const lead = await newLead();
    const seen = captureAtResend();
    await compose(lead, randomUUID(), { threadId: "resend:earlier-email" });
    assert.equal(seen[0][0].thread_id, "resend:earlier-email");
    assert.equal((await onlyEmail()).thread_id, "resend:earlier-email");
  });

  it("the same draft and content never sends twice", async () => {
    const lead = await newLead();
    const draft = randomUUID();
    const first = await compose(lead, draft);
    const again = await compose(lead, draft);
    assert.deepEqual(again, first);
    assert.equal(providers.resend.calls.length, 1);
    assert.equal((await emails()).length, 1);
  });

  it("the same draft with different content, person, recipients or thread is refused; nothing is sent or changed", async () => {
    const lead = await newLead();
    const other = await newLead({ email: "bo@example.com" });
    const draft = randomUUID();
    await compose(lead, draft);
    const before = await onlyEmail();
    for (const change of [
      { subject: "Different subject" },
      { bodyHtml: "<p>Different</p>" },
      { to: [{ email: "bo@example.com", name: null }] },
      { cc: [{ email: "cc@example.com", name: null }] },
      { contactId: other },
      { threadId: "resend:other-thread" },
    ] satisfies ComposeOverrides[]) {
      const result = await compose(lead, draft, change);
      assert.equal(result.outcome, "draft_conflict", JSON.stringify(change));
    }
    assert.equal(providers.resend.calls.length, 1);
    assert.deepEqual(await onlyEmail(), before);
  });

  it("a failed email stays retryable under the same draft, on the same record and thread", async () => {
    const lead = await newLead();
    const draft = randomUUID();
    reject422();
    const failed = await compose(lead, draft);
    assert.equal(failed.outcome, "not_sent");
    assert.deepEqual([composerAfterSend(failed).draft, composerAfterSend(failed).newIdentity], ["restore", false]);
    const failedRow = await onlyEmail();
    assert.equal(failedRow.status, "failed");

    assert.equal((await compose(lead, draft, { subject: "Edited after failure" })).outcome, "draft_conflict");
    const retried = await compose(lead, draft);
    assert.equal(retried.outcome, "sent");
    const row = await onlyEmail();
    assert.deepEqual([row.id, row.status, row.thread_id], [failedRow.id, "sent", composeEmailThreadId(draft)]);
    assert.equal(providers.resend.calls.length, 2);
  });

  it("a timeout or 5xx is not confirmed: no plain resend in the composer, and the same draft never sends again", async () => {
    for (const fault of [() => providers.resend.throwNext(timeout()), () => providers.resend.respondNext(503, { message: "Unavailable" })]) {
      await db.query("delete from public.crm_emails");
      providers.reset();
      const lead = await newLead();
      const draft = randomUUID();
      fault();
      const result = await compose(lead, draft);
      assert.equal(result.outcome, "not_confirmed");
      assert.equal(result.outcome === "not_confirmed" && result.sendStatus, "unknown");
      const next = composerAfterSend(result);
      assert.deepEqual([next.draft, next.newIdentity], ["clear", true]);
      assert.equal((await onlyEmail()).status, "unknown");

      assert.equal((await compose(lead, draft)).outcome, "not_confirmed");
      assert.equal(providers.resend.calls.length, 1);
    }
  });

  it("when Resend's acceptance can't be saved, the email is not confirmed and stays pending, never sent", async () => {
    const lead = await newLead();
    const draft = randomUUID();
    const result = await withoutPrivilege("crm_emails", "update", () => compose(lead, draft));
    assert.equal(result.outcome, "not_confirmed");
    assert.equal(result.outcome === "not_confirmed" && result.sendStatus, "pending");
    const row = await onlyEmail();
    assert.deepEqual([row.status, row.provider_message_id, row.sent_at], ["pending", null, null]);
    assert.equal((await compose(lead, draft)).outcome, "not_confirmed");
    assert.equal(providers.resend.calls.length, 1);
    const activities = await db.query("select 1 from public.contact_activities where contact_id = $1", [lead]);
    assert.equal(activities.length, 0, "no 'Email sent' activity for an unconfirmed email");
  });

  it("when the record can't be written, Resend is never called", async () => {
    const lead = await newLead();
    const result = await withoutPrivilege("crm_emails", "insert", () => compose(lead, randomUUID()));
    assert.deepEqual(result, { outcome: "not_attempted", error: "The email couldn't be recorded, so it wasn't sent." });
    assert.equal(providers.resend.calls.length, 0);
  });

  it("the purpose is always conversational, whatever the caller passes", async () => {
    const lead = await newLead();
    const sneaky = { purpose: "transactional", metadata: { purpose: "transactional" } } as unknown as ComposeOverrides;
    await compose(lead, randomUUID(), sneaky);
    assert.equal((await onlyEmail()).metadata.purpose, "conversational");
  });

  it("an unsubscribed person isn't emailed, linked or as a to/cc address, and nothing is recorded", async () => {
    const unsubscribed = await newLead({ email: "gone@example.com", unsubscribed: true });
    const lead = await newLead();
    const blocked = [
      await compose(unsubscribed, randomUUID(), { to: [{ email: "gone@example.com", name: null }] }),
      await compose(null, randomUUID(), { to: [{ email: "GONE@example.com", name: null }] }),
      await compose(lead, randomUUID(), { cc: [{ email: "gone@example.com", name: null }] }),
    ];
    for (const result of blocked) assert.equal(result.outcome, "not_attempted");
    assert.equal(providers.resend.calls.length, 0);
    assert.equal((await emails()).length, 0);
  });

  it("a draft belongs to its user and workspace: the same draft id elsewhere is a separate email", async () => {
    const lead = await newLead();
    const draft = randomUUID();
    await compose(lead, draft);
    assert.equal((await compose(lead, draft, { userId: randomUUID(), subject: "Teammate's email" })).outcome, "sent");
    const otherTenant = await newTenant();
    const otherLead = await newLead({ tenantId: otherTenant });
    assert.equal((await compose(otherLead, draft, { tenantId: otherTenant, subject: "Other workspace" })).outcome, "sent");
    assert.equal(providers.resend.calls.length, 3);
    const rows = await emails();
    assert.equal(rows.filter((row) => row.tenant_id === tenant).length, 2);
    assert.equal(rows.filter((row) => row.tenant_id === otherTenant).length, 1);
  });

  it("a malformed draft identity sends and records nothing", async () => {
    const result = await compose(await newLead(), "not-a-uuid");
    assert.equal(result.outcome, "not_attempted");
    assert.equal(providers.resend.calls.length, 0);
    assert.equal((await emails()).length, 0);
  });
});

// ---------- No send-then-save path ----------

describe("no email is saved only after Resend accepted it", () => {
  it("the send-then-save recorder is gone and nothing sends email outside the outbound record", () => {
    const appRoot = new URL("../../../../", import.meta.url).pathname;
    assert.equal(existsSync(join(appRoot, "src/lib/email/record-outbound-email.ts")), false);
    const callers: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const path = join(dir, name);
        if (statSync(path).isDirectory()) walk(path);
        else if (/\.tsx?$/.test(name) && !name.endsWith(".test.ts")) {
          const text = readFileSync(path, "utf8");
          if (/record-outbound-email|could not be saved in REOS/.test(text)) callers.push(path);
          if (/(?<!function )\bsendResendMessage\(/.test(text)) callers.push(`sendResendMessage: ${path.slice(appRoot.length)}`);
        }
      }
    };
    walk(join(appRoot, "src"));
    walk(join(appRoot, "app"));
    assert.deepEqual(callers.sort(), [
      "sendResendMessage: src/lib/calendar/appointment-invites.ts",
      "sendResendMessage: src/lib/email/send-ledgered-email.ts",
    ]);
  });
});
