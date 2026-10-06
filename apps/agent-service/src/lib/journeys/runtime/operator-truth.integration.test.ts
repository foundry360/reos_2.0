/**
 * E.3a manual compose operator truth: a composed SMS / Messenger / Instagram
 * message is one operation named by its draft identity. The same draft and
 * content are the same send, a draft reused for other content is refused, a
 * failed send can be retried, a send that isn't confirmed is never sent again
 * on its own, and consent rules are unchanged.
 *
 * The real sendComposedMessage, deliverMessageToContact, outbound message
 * record, provider senders and Meta inbound handler run unmodified; Supabase is
 * PGlite behind the PostgREST bridge (with the real migrations 064 and 065);
 * Telnyx and Meta are recorded fakes. live-actions-test-env.ts must be the
 * first import; it fails closed on any other network access.
 */

import { attachTestDb, blockedRequests, LIVE_ACTIONS_SCHEMA, providers } from "./live-actions-test-env.ts";

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, afterEach, beforeEach, describe, it } from "node:test";
import { createTestDb } from "./lead-status-test-db.ts";
import { composerAfterSend } from "../../messaging/compose-draft.ts";

// Range filters on: the Meta echo check looks back two minutes.
const db = await createTestDb({ schema: LIVE_ACTIONS_SCHEMA, rangeFilters: true });
attachTestDb(db);
const { sendComposedMessage, composeOperationKey } = await import("../../messaging/compose-message.ts");
const { handleInboundMetaMessage } = await import("../../handle-inbound-meta.ts");
const { recordReplyOutcome } = await import("../../messaging/outbound-messages.ts");
const { clearPlatformSecretCache } = await import("../../admin/platform-secrets.ts");

const service = db.client("service_role");
const USER = randomUUID();
const PRIMARY = "+15559990000";

let tenant: string;

after(async () => {
  await db.pg.close();
});

beforeEach(async () => {
  await db.reset();
  providers.reset();
  clearPlatformSecretCache();
  [{ id: tenant }] = await db.query<{ id: string }>("insert into public.tenants default values returning id");
  await db.query("insert into public.tenant_phone_numbers (tenant_id, phone_e164, is_primary) values ($1, $2, true)", [tenant, PRIMARY]);
  for (const channel of ["messenger", "instagram"]) {
    await db.query(
      `insert into public.channel_accounts (tenant_id, channel, external_page_id, external_account_id, status, metadata)
       values ($1, $2, $3, $4, 'connected', $5)`,
      [tenant, channel, `page-${channel}`, `acct-${channel}`, JSON.stringify({ access_token: `token-${channel}` })],
    );
  }
});

afterEach(() => {
  assert.deepEqual(blockedRequests, [], "no request may leave the test environment");
});

// ---------- Seed helpers (direct SQL, outside the code under test) ----------

async function newLead(state: { opted_out?: boolean; handoff?: boolean } = {}): Promise<string> {
  const [{ id }] = await db.query<{ id: string }>(
    `insert into public.contacts (tenant_id, first_name, last_name, email, opted_out, handoff)
     values ($1, 'Ana', 'Lima', 'ana@example.com', $2, $3) returning id`,
    [tenant, state.opted_out ?? false, state.handoff ?? false],
  );
  await db.query(
    "insert into public.contact_identities (contact_id, channel, external_id) values ($1, 'sms', $2), ($1, 'messenger', $3), ($1, 'instagram', $4)",
    [id, `+1555${String(Math.floor(Math.random() * 1e7)).padStart(7, "0")}`, `psid-${id}`, `igsid-${id}`],
  );
  return id;
}

async function addInbound(contactId: string, channel: string, minutesAgo = 5) {
  await db.query(
    `insert into public.messages (tenant_id, contact_id, channel, direction, body, created_at)
     values ($1, $2, $3, 'inbound', 'Hi there', now() - make_interval(mins => $4))`,
    [tenant, contactId, channel, minutesAgo],
  );
}

interface MessageRow {
  id: string;
  contact_id: string;
  channel: string;
  body: string;
  send_status: string | null;
  idempotency_key: string | null;
}

function outbound(): Promise<MessageRow[]> {
  return db.query<MessageRow>("select * from public.messages where direction = 'outbound' and tenant_id = $1 order by created_at, id", [tenant]);
}

const timeout = () => Object.assign(new Error("The operation was aborted due to timeout"), { name: "TimeoutError" });

function compose(contactId: string, draftId: string, extra: { channel?: "sms" | "messenger" | "instagram"; body?: string; userId?: string } = {}) {
  return sendComposedMessage(service, {
    tenantId: tenant,
    userId: extra.userId ?? USER,
    contactId,
    channel: extra.channel ?? "sms",
    body: extra.body ?? "Hi Ana",
    draftId,
  });
}

const providerCalls = () => providers.telnyx.calls.length + providers.meta.calls.length;

// ---------- Tests ----------

describe("manual compose: draft identity", () => {
  it("the same draft and content is one send: a double submit doesn't send twice", async () => {
    const lead = await newLead();
    const draft = randomUUID();
    const first = await compose(lead, draft);
    assert.equal(first.outcome, "sent");
    const again = await compose(lead, draft);
    assert.deepEqual(again, first);
    assert.equal(providers.telnyx.calls.length, 1);
    const rows = await outbound();
    assert.equal(rows.length, 1);
    assert.equal(rows[0].send_status, "sent");
    assert.equal(rows[0].idempotency_key, composeOperationKey(USER, draft));
  });

  it("a draft reused for changed content is refused and nothing is sent", async () => {
    const lead = await newLead();
    const draft = randomUUID();
    await compose(lead, draft);
    const changed = await compose(lead, draft, { body: "Hi Ana, different" });
    assert.equal(changed.outcome, "draft_conflict");
    assert.equal(providers.telnyx.calls.length, 1);
    const rows = await outbound();
    assert.equal(rows.length, 1);
    assert.equal(rows[0].body, "Hi Ana");
  });

  it("a draft reused for another channel or another person is refused", async () => {
    const lead = await newLead();
    const other = await newLead();
    await addInbound(lead, "messenger");
    const draft = randomUUID();
    await compose(lead, draft);
    assert.equal((await compose(lead, draft, { channel: "messenger" })).outcome, "draft_conflict");
    assert.equal((await compose(other, draft)).outcome, "draft_conflict");
    assert.equal(providerCalls(), 1);
  });

  it("a draft reused after a failure for changed content is refused too", async () => {
    const lead = await newLead();
    const draft = randomUUID();
    providers.telnyx.respondNext(422, { errors: [{ detail: "Invalid destination" }] });
    assert.equal((await compose(lead, draft)).outcome, "not_sent");
    assert.equal((await compose(lead, draft, { body: "Edited" })).outcome, "draft_conflict");
    assert.equal(providers.telnyx.calls.length, 1);
  });

  it("a failed send stays retryable under the same draft, on the same record", async () => {
    const lead = await newLead();
    const draft = randomUUID();
    providers.telnyx.respondNext(422, { errors: [{ detail: "Invalid destination" }] });
    const failed = await compose(lead, draft);
    assert.equal(failed.outcome, "not_sent");
    const after = composerAfterSend(failed);
    assert.equal(after.draft, "restore");
    assert.equal(after.newIdentity, false);
    assert.equal((await outbound())[0].send_status, "failed");

    const retried = await compose(lead, draft);
    assert.equal(retried.outcome, "sent");
    assert.equal(providers.telnyx.calls.length, 2);
    const rows = await outbound();
    assert.equal(rows.length, 1);
    assert.equal(rows[0].send_status, "sent");
  });

  it("after a confirmed send, a new message needs a new draft identity", async () => {
    const lead = await newLead();
    const draft = randomUUID();
    const sent = await compose(lead, draft);
    assert.equal(composerAfterSend(sent).newIdentity, true);
    assert.equal((await compose(lead, draft, { body: "Second message" })).outcome, "draft_conflict");
    assert.equal((await compose(lead, randomUUID(), { body: "Second message" })).outcome, "sent");
    assert.equal(providers.telnyx.calls.length, 2);
    assert.equal((await outbound()).length, 2);
  });

  it("drafts are per user: another user's identical draft id is a different operation", async () => {
    const lead = await newLead();
    const draft = randomUUID();
    await compose(lead, draft);
    assert.equal((await compose(lead, draft, { userId: randomUUID(), body: "From a teammate" })).outcome, "sent");
    assert.equal(providers.telnyx.calls.length, 2);
  });

  it("a malformed draft identity sends nothing", async () => {
    const lead = await newLead();
    const result = await compose(lead, "not-a-uuid");
    assert.equal(result.outcome, "not_attempted");
    assert.equal(providerCalls(), 0);
    assert.equal((await outbound()).length, 0);
  });
});

describe("manual compose: a send that isn't confirmed", () => {
  for (const channel of ["sms", "messenger", "instagram"] as const) {
    it(`${channel}: not confirmed, the draft isn't restored for an ordinary resend, and the same draft never sends again`, async () => {
      const lead = await newLead();
      if (channel !== "sms") await addInbound(lead, channel);
      const fake = channel === "sms" ? providers.telnyx : providers.meta;
      fake.throwNext(timeout());
      const draft = randomUUID();
      const result = await compose(lead, draft, { channel });
      assert.equal(result.outcome, "not_confirmed");
      assert.equal(result.outcome === "not_confirmed" && result.sendStatus, "unknown");

      const next = composerAfterSend(result);
      assert.equal(next.draft, "clear");
      assert.equal(next.newIdentity, true);
      assert.equal(next.bubble?.status, "unknown");
      assert.match(next.notice ?? "", /^Not confirmed: this message may have been sent/);

      // What the thread shows after a reload: the record, not confirmed, text intact.
      const [row] = await outbound();
      assert.equal(row.send_status, "unknown");
      assert.equal(row.body, "Hi Ana");

      // A resubmit of the same draft (a double click, a retried request) doesn't send.
      const again = await compose(lead, draft, { channel });
      assert.equal(again.outcome, "not_confirmed");
      assert.equal(fake.calls.length, 1);
      assert.equal((await outbound()).length, 1);
    });
  }

  it("a draft still pending (another request in flight) reads not confirmed and doesn't send", async () => {
    const lead = await newLead();
    const draft = randomUUID();
    await db.query(
      `insert into public.messages (tenant_id, contact_id, channel, direction, body, send_status, idempotency_key)
       values ($1, $2, 'sms', 'outbound', 'Hi Ana', 'pending', $3)`,
      [tenant, lead, composeOperationKey(USER, draft)],
    );
    const result = await compose(lead, draft);
    assert.equal(result.outcome, "not_confirmed");
    assert.equal(result.outcome === "not_confirmed" && result.sendStatus, "pending");
    assert.equal(providers.telnyx.calls.length, 0);
  });

  it("a Meta echo matching an unknown send doesn't make it sent", async () => {
    const lead = await newLead();
    await addInbound(lead, "messenger");
    providers.meta.throwNext(timeout());
    await compose(lead, randomUUID(), { channel: "messenger" });
    const echo = await handleInboundMetaMessage(
      { channel: "messenger", pageOrAccountId: "page-messenger", contactExternalId: `psid-${lead}`, direction: "outbound", text: "Hi Ana", mid: null },
      {
        resolveTenantId: async () => tenant,
        loadPageToken: async () => "page-token",
        fetchProfile: async () => null,
        resolveContact: async () => ({ phone: `psid-${lead}`, accountId: tenant, contactId: lead, leadStatus: "New", readyToBook: false, apptBooked: false, handoff: false, optedOut: false }),
        sendText: async () => ({ ok: true, messageId: null }),
        recordOutcome: recordReplyOutcome,
      },
    );
    assert.equal(echo.ok, true);
    const rows = await outbound();
    assert.equal(rows.length, 1);
    assert.equal(rows[0].send_status, "unknown");
    assert.equal(providers.meta.calls.length, 1);
  });
});

describe("manual compose: consent is unchanged", () => {
  it("an opted-out person gets nothing on any channel, and nothing is recorded", async () => {
    const lead = await newLead({ opted_out: true });
    await addInbound(lead, "messenger");
    for (const channel of ["sms", "messenger", "instagram"] as const) {
      const result = await compose(lead, randomUUID(), { channel });
      assert.equal(result.outcome, "not_attempted");
    }
    assert.equal(providerCalls(), 0);
    assert.equal((await outbound()).length, 0);
  });

  it("Messenger outside the 24-hour window is blocked; inside it sends", async () => {
    const lead = await newLead();
    await addInbound(lead, "messenger", 25 * 60);
    const draft = randomUUID();
    const blocked = await compose(lead, draft, { channel: "messenger" });
    assert.equal(blocked.outcome, "not_attempted");
    assert.equal(composerAfterSend(blocked).draft, "restore");
    assert.equal(providers.meta.calls.length, 0);
    await addInbound(lead, "messenger");
    assert.equal((await compose(lead, draft, { channel: "messenger" })).outcome, "sent");
  });

  it("a manual send still reaches a person handed off to a human", async () => {
    const lead = await newLead({ handoff: true });
    assert.equal((await compose(lead, randomUUID())).outcome, "sent");
    assert.equal(providers.telnyx.calls.length, 1);
  });
});
