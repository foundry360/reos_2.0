/**
 * Provider redelivery for inbound Telnyx SMS and Meta DMs: the real handlers,
 * the real inbound claim (messages insert through supabase-js), the real
 * migration 060 triggers, and the real journey event dispatcher. Replaced: the
 * AI turn (a recorded fake), contact/tenant lookup, Meta Graph calls, and the
 * after-response fast path (so only the explicit drain delivers events).
 * live-actions-test-env.ts must be the first import; it fails closed on any
 * other network access.
 */

import { attachTestDb, blockedRequests } from "./live-actions-test-env.ts";

import assert from "node:assert/strict";
import { afterEach, after, beforeEach, describe, it } from "node:test";
import type { JourneyAIExecutor } from "./ai.ts";
import { dispatchJourneyEvent, type ActionExecutor, type EngineDeps } from "./engine.ts";
import type { JourneySnapshot } from "./graph.ts";
import { createSupabaseJourneyEventOutbox, dispatchJourneyEvents } from "./journey-event-outbox.ts";
import { createJourneyEventsTestDb } from "./journey-events-test-db.ts";
import { DEFAULT_OUTBOX_OPTIONS } from "./lead-status-outbox.ts";
import { MemoryJourneyStore } from "./memory-store.ts";
import type { ContactContext } from "../../coordinator.ts";
import type { InboundTurnDeps } from "../../inbound-turn.ts";
import type { InboundAgentResult } from "../../run-inbound-agent.ts";
import type { MetaWebhookMessage } from "../../meta/webhook.ts";

const db = await createJourneyEventsTestDb();
attachTestDb(db);
const { handleInboundSms, parseTelnyxInboundSms } = await import("../../handle-inbound.ts");
const { handleInboundMetaMessage } = await import("../../handle-inbound-meta.ts");
const { attachIntakeIdentity, claimInboundMessage } = await import("../../db/contacts.ts");
const { parseMetaWebhookPayload } = await import("../../meta/webhook.ts");

const service = db.client("service_role");

let tenant: string;
let contact: string;
let store: MemoryJourneyStore;
let deps: EngineDeps;

const ai: JourneyAIExecutor = { execute: async () => ({ success: true, output: {}, text: "" }) };
const actions: ActionExecutor = { execute: async () => ({ status: "completed", output: {} }) };

after(async () => {
  await db.pg.close();
});

beforeEach(async () => {
  await db.reset();
  [{ id: tenant }] = await db.query<{ id: string }>("insert into public.tenants default values returning id");
  [{ id: contact }] = await db.query<{ id: string }>("insert into public.contacts (tenant_id) values ($1) returning id", [tenant]);
  store = new MemoryJourneyStore();
  store.contacts.set(contact, { tenantId: tenant, lead: { lead_status: "New", record_type: "lead" } });
  deps = { store, actions, ai };
  // Trigger → wait: one active run per contact, so a duplicate run would be visible.
  const snapshot: JourneySnapshot = {
    nodes: [
      { id: "t", type: "trigger", name: "Message", description: "", config: { event: "message.received", filters: [] } },
      { id: "w", type: "action", name: "Wait", description: "", config: { action: "wait", duration: 1, unit: "days" } },
    ],
    connections: [{ id: "c", sourceNodeId: "t", targetNodeId: "w", sourceHandle: null, targetHandle: null }],
  };
  store.saveJourney(tenant, "j-reply", snapshot);
});

afterEach(() => {
  assert.deepEqual(blockedRequests, [], "no request may leave the test environment");
});

// ---------- Fakes and observations ----------

function ctx(channel: "sms" | "messenger" | "instagram" = "sms"): ContactContext {
  return {
    phone: channel === "sms" ? "+15550001111" : "psid-1",
    accountId: tenant,
    contactId: contact,
    leadStatus: "New",
    readyToBook: false,
    apptBooked: false,
    handoff: false,
    optedOut: false,
  };
}

interface Recorder {
  agentCalls: Array<{ inboundPersisted?: boolean; body: string }>;
  soon: number;
  turn: InboundTurnDeps;
}

/** AI turn fake: records each call; `behavior` can block or throw to model in-flight and crashed turns. */
function recorder(behavior: () => Promise<void> = async () => {}): Recorder {
  const rec: Recorder = {
    agentCalls: [],
    soon: 0,
    turn: {
      claim: claimInboundMessage,
      runAgent: async (params): Promise<InboundAgentResult> => {
        rec.agentCalls.push({ inboundPersisted: params.inboundPersisted, body: params.body });
        await behavior();
        return { reply: `Reply to: ${params.body}`, playbook: "concierge", contactId: params.ctx.contactId, optedOut: false };
      },
      dispatchSoon: () => {
        rec.soon++;
      },
    },
  };
  return rec;
}

function sms(rec: Recorder, providerMessageId: string | null, body = "Is the house still available?") {
  return handleInboundSms(
    { from: "+15550001111", to: "+15559990000", body, providerMessageId },
    { resolveContact: async () => ctx("sms"), turn: rec.turn },
  );
}

interface MetaSends {
  calls: Array<{ recipientId: string; text: string }>;
}

function metaDm(rec: Recorder, sends: MetaSends, mid: string | null, text = "Hi, is this listing open?") {
  const message: MetaWebhookMessage = {
    channel: "messenger",
    pageOrAccountId: "page-1",
    contactExternalId: "psid-1",
    direction: "inbound",
    text,
    mid,
  };
  return handleInboundMetaMessage(message, {
    resolveTenantId: async () => tenant,
    loadPageToken: async () => "page-token",
    fetchProfile: async () => null,
    resolveContact: async () => ctx("messenger"),
    sendText: async (params) => {
      sends.calls.push({ recipientId: params.recipientId, text: params.text });
      return { ok: true };
    },
    turn: rec.turn,
  });
}

const messages = () => db.query<{ id: string; provider_message_id: string | null; channel: string }>("select * from public.messages");
const events = () =>
  db.query<{ event_type: string; source_id: string; entity_id: string; dispatched_at: Date | null }>("select * from public.journey_events");
const runs = () => [...store.runs.values()];

/** The cron drain (or the fast path) delivering whatever is pending. */
async function drain(): Promise<string[]> {
  const outcomes: string[] = [];
  await dispatchJourneyEvents(
    createSupabaseJourneyEventOutbox(service),
    async (event) => {
      const result = await dispatchJourneyEvent(deps, event);
      outcomes.push(...result.map((entry) => entry.result));
      return result;
    },
    { ...DEFAULT_OUTBOX_OPTIONS, budgetMs: 60_000 },
  );
  return outcomes;
}

/** Exactly one of everything for one provider message. */
async function assertOnce(rec: Recorder, sourceId: string) {
  assert.equal(rec.agentCalls.length, 1, "one AI turn");
  const stored = await messages();
  assert.equal(stored.length, 1, "one message row");
  const received = await events();
  assert.equal(received.length, 1, "one message.received");
  assert.equal(received[0].source_id, sourceId);
  assert.equal(received[0].entity_id, stored[0].id);
}

function deferred() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

// ---------- Provider id extraction ----------

describe("provider message identity", () => {
  it("Telnyx: the message id (data.payload.id), else the webhook event id (data.id); other events are ignored", () => {
    const inbound = (data: Record<string, unknown>) =>
      parseTelnyxInboundSms({
        data: {
          event_type: "message.received",
          ...data,
          payload: { direction: "inbound", text: "hi", from: { phone_number: "+1555" }, to: [{ phone_number: "+1666" }], ...(data.payload as object) },
        },
      });
    assert.deepEqual(inbound({ id: "evt-1", payload: { id: "msg-1" } }), { from: "+1555", to: "+1666", body: "hi", providerMessageId: "msg-1" });
    assert.equal(inbound({ id: "evt-1", payload: {} })?.providerMessageId, "evt-1");
    assert.equal(inbound({ payload: {} })?.providerMessageId, null);
    assert.equal(parseTelnyxInboundSms({ data: { event_type: "message.sent", payload: { direction: "outbound" } } }), null);
    assert.equal(parseTelnyxInboundSms({ data: { event_type: "message.received", payload: { direction: "outbound" } } }), null);
    assert.equal(parseTelnyxInboundSms(null), null);
  });

  it("Meta: the message mid", () => {
    const [message] = parseMetaWebhookPayload({
      object: "page",
      entry: [{ id: "page-1", messaging: [{ sender: { id: "psid-1" }, recipient: { id: "page-1" }, message: { mid: "m_abc", text: "hi" } }] }],
    });
    assert.equal(message.mid, "m_abc");
  });
});

// ---------- Telnyx SMS ----------

describe("Telnyx SMS redelivery", () => {
  it("first delivery: claims the message, records message.received, runs one AI turn, replies", async () => {
    const rec = recorder();
    const result = await sms(rec, "tx-1");
    assert.equal(result.duplicate, undefined);
    assert.equal(result.reply, "Reply to: Is the house still available?");
    assert.deepEqual(rec.agentCalls, [{ inboundPersisted: true, body: "Is the house still available?" }]);
    assert.equal(rec.soon, 1, "fast path requested");
    await assertOnce(rec, "sms:tx-1");
    assert.equal((await messages())[0].provider_message_id, "tx-1");
  });

  it("immediate duplicate: no second message, event, AI turn, reply, or run", async () => {
    const rec = recorder();
    await sms(rec, "tx-1");
    const again = await sms(rec, "tx-1");
    assert.deepEqual(again, { reply: "", playbook: "none", contactId: contact, duplicate: true });
    await assertOnce(rec, "sms:tx-1");
    assert.deepEqual(await drain(), ["started"]);
    assert.equal(runs().length, 1);
  });

  it("duplicate after the first delivery completed and was dispatched", async () => {
    const rec = recorder();
    await sms(rec, "tx-1");
    assert.deepEqual(await drain(), ["started"]);
    const again = await sms(rec, "tx-1");
    assert.equal(again.duplicate, true);
    assert.equal(again.reply, "");
    assert.deepEqual(await drain(), []);
    await assertOnce(rec, "sms:tx-1");
    assert.equal(runs().length, 1);
  });

  it("duplicate while the first delivery is still in its AI turn", async () => {
    const gate = deferred();
    const rec = recorder(() => gate.promise);
    const first = sms(rec, "tx-1");
    await new Promise((resolve) => setTimeout(resolve, 20));
    const second = await sms(rec, "tx-1");
    assert.equal(second.duplicate, true);
    assert.equal(rec.agentCalls.length, 1, "the duplicate never reached the AI");
    gate.release();
    assert.equal((await first).reply, "Reply to: Is the house still available?");
    await assertOnce(rec, "sms:tx-1");
  });

  it("concurrent deliveries of one message: exactly one wins the claim", async () => {
    const rec = recorder();
    const results = await Promise.all([sms(rec, "tx-1"), sms(rec, "tx-1"), sms(rec, "tx-1")]);
    assert.equal(results.filter((result) => !result.duplicate).length, 1);
    await assertOnce(rec, "sms:tx-1");
  });

  it("crash after the claim (AI turn throws): the event is durable; redelivery does nothing; the drain starts one run", async () => {
    const rec = recorder(async () => {
      throw new Error("process died mid-turn");
    });
    await assert.rejects(sms(rec, "tx-1"), /process died/);
    const again = await sms(rec, "tx-1");
    assert.equal(again.duplicate, true);
    await assertOnce(rec, "sms:tx-1");
    assert.deepEqual(await drain(), ["started"]);
    assert.equal(runs().length, 1);
  });

  it("crash after the message is persisted but before AI processing: no AI turn on redelivery, event still delivered", async () => {
    const rec = recorder();
    rec.turn = {
      ...rec.turn,
      claim: async (params) => {
        await claimInboundMessage(params);
        throw new Error("process died after commit");
      },
    };
    await assert.rejects(sms(rec, "tx-1"), /died after commit/);
    assert.equal(rec.agentCalls.length, 0);
    const retry = recorder();
    const again = await sms(retry, "tx-1");
    assert.equal(again.duplicate, true);
    assert.equal(retry.agentCalls.length, 0);
    assert.equal((await messages()).length, 1);
    assert.equal((await events()).length, 1);
    assert.deepEqual(await drain(), ["started"]);
  });

  it("crash after the durable event is created, before the fast path: the cron drain delivers it once", async () => {
    const rec = recorder();
    rec.turn = { ...rec.turn, dispatchSoon: () => { throw new Error("process died before dispatch"); } };
    await assert.rejects(sms(rec, "tx-1"), /before dispatch/);
    const [event] = await events();
    assert.equal(event.dispatched_at, null);
    assert.equal((await sms(recorder(), "tx-1")).duplicate, true);
    assert.deepEqual(await drain(), ["started"]);
    assert.deepEqual(await drain(), []);
    assert.equal(runs().length, 1);
  });

  it("two different messages are two turns, two events; the second finds the journey already active", async () => {
    const rec = recorder();
    await sms(rec, "tx-1", "first");
    await sms(rec, "tx-2", "second");
    assert.equal(rec.agentCalls.length, 2);
    assert.deepEqual((await events()).map((row) => row.source_id).sort(), ["sms:tx-1", "sms:tx-2"]);
    assert.deepEqual(await drain(), ["started", "already_active"]);
    assert.equal(runs().length, 1);
  });

  it("no provider id: nothing to dedupe on, so the agent stores the message itself (unchanged behavior)", async () => {
    const rec = recorder();
    await sms(rec, null);
    assert.deepEqual(rec.agentCalls, [{ inboundPersisted: false, body: "Is the house still available?" }]);
    assert.equal((await messages()).length, 0, "the handler stored nothing");
    assert.equal(rec.soon, 0);
  });

  it("a stub contact (unknown number) can't be claimed and runs as before", async () => {
    const rec = recorder();
    await handleInboundSms(
      { from: "+15550001111", body: "hi", providerMessageId: "tx-1" },
      { resolveContact: async () => ({ ...ctx(), contactId: undefined, accountId: "default-tenant" }), turn: rec.turn },
    );
    assert.equal(rec.agentCalls[0].inboundPersisted, false);
    assert.equal((await messages()).length, 0);
  });
});

// ---------- Meta DMs ----------

describe("Meta DM redelivery", () => {
  it("first delivery: claims by mid, records message.received, one AI turn, one Graph reply", async () => {
    const rec = recorder();
    const sends: MetaSends = { calls: [] };
    const result = await metaDm(rec, sends, "m_1");
    assert.equal(result.sent, true);
    assert.deepEqual(sends.calls, [{ recipientId: "psid-1", text: "Reply to: Hi, is this listing open?" }]);
    await assertOnce(rec, "messenger:m_1");
  });

  it("immediate duplicate: skipped as duplicate, no AI turn, no reply", async () => {
    const rec = recorder();
    const sends: MetaSends = { calls: [] };
    await metaDm(rec, sends, "m_1");
    const again = await metaDm(rec, sends, "m_1");
    assert.deepEqual(again, { ok: true, contactId: contact, tenantId: tenant, skipped: "duplicate" });
    assert.equal(sends.calls.length, 1);
    await assertOnce(rec, "messenger:m_1");
  });

  it("duplicate after the first delivery completed and was dispatched", async () => {
    const rec = recorder();
    const sends: MetaSends = { calls: [] };
    await metaDm(rec, sends, "m_1");
    assert.deepEqual(await drain(), ["started"]);
    assert.equal((await metaDm(rec, sends, "m_1")).skipped, "duplicate");
    assert.deepEqual(await drain(), []);
    assert.equal(sends.calls.length, 1);
    await assertOnce(rec, "messenger:m_1");
  });

  it("duplicate while the first is still running (Meta retries a slow synchronous webhook)", async () => {
    const gate = deferred();
    const rec = recorder(() => gate.promise);
    const sends: MetaSends = { calls: [] };
    const first = metaDm(rec, sends, "m_1");
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal((await metaDm(rec, sends, "m_1")).skipped, "duplicate");
    assert.equal(sends.calls.length, 0);
    gate.release();
    assert.equal((await first).sent, true);
    assert.equal(sends.calls.length, 1);
    await assertOnce(rec, "messenger:m_1");
  });

  it("crash after the claim: redelivery sends nothing; the event is delivered by the drain", async () => {
    const rec = recorder(async () => {
      throw new Error("process died mid-turn");
    });
    const sends: MetaSends = { calls: [] };
    await assert.rejects(metaDm(rec, sends, "m_1"), /process died/);
    assert.equal((await metaDm(recorder(), sends, "m_1")).skipped, "duplicate");
    assert.equal(sends.calls.length, 0);
    assert.deepEqual(await drain(), ["started"]);
    await assertOnce(rec, "messenger:m_1");
  });

  it("crash after the message is persisted but before AI processing", async () => {
    const rec = recorder();
    rec.turn = {
      ...rec.turn,
      claim: async (params) => {
        await claimInboundMessage(params);
        throw new Error("process died after commit");
      },
    };
    const sends: MetaSends = { calls: [] };
    await assert.rejects(metaDm(rec, sends, "m_1"), /died after commit/);
    const retry = recorder();
    assert.equal((await metaDm(retry, sends, "m_1")).skipped, "duplicate");
    assert.equal(retry.agentCalls.length + rec.agentCalls.length, 0);
    assert.equal(sends.calls.length, 0);
    assert.equal((await events()).length, 1);
    assert.deepEqual(await drain(), ["started"]);
  });

  it("crash after the durable event is created, before the fast path", async () => {
    const rec = recorder();
    rec.turn = { ...rec.turn, dispatchSoon: () => { throw new Error("process died before dispatch"); } };
    const sends: MetaSends = { calls: [] };
    await assert.rejects(metaDm(rec, sends, "m_1"), /before dispatch/);
    assert.equal((await metaDm(recorder(), sends, "m_1")).skipped, "duplicate");
    assert.deepEqual(await drain(), ["started"]);
    assert.deepEqual(await drain(), []);
    assert.equal(runs().length, 1);
  });

  it("the same mid on Instagram is a different provider message", async () => {
    const rec = recorder();
    await metaDm(rec, { calls: [] }, "m_1");
    await handleInboundMetaMessage(
      { channel: "instagram", pageOrAccountId: "ig-1", contactExternalId: "igsid-1", direction: "inbound", text: "hello", mid: "m_1" },
      {
        resolveTenantId: async () => tenant,
        loadPageToken: async () => null,
        fetchProfile: async () => null,
        resolveContact: async () => ctx("instagram"),
        sendText: async () => ({ ok: true }),
        turn: rec.turn,
      },
    );
    assert.equal(rec.agentCalls.length, 2);
    assert.deepEqual((await events()).map((row) => row.source_id).sort(), ["instagram:m_1", "messenger:m_1"]);
  });
});

// ---------- Intake race ----------

describe("first-touch intake race", () => {
  it("the contact whose identity insert loses is removed and records no lead.created", async () => {
    const [{ id: loser }] = await db.query<{ id: string }>("insert into public.contacts (tenant_id) values ($1) returning id", [tenant]);
    assert.equal(await attachIntakeIdentity(service, { contactId: contact, channel: "sms", externalId: "15550001111" }), "attached");
    assert.equal(await attachIntakeIdentity(service, { contactId: loser, channel: "sms", externalId: "15550001111" }), "conflict");
    assert.equal((await db.query("select id from public.contacts where id = $1", [loser])).length, 0);
    const rows = await db.query<{ event_type: string; contact_id: string; payload: unknown }>("select * from public.journey_events");
    assert.deepEqual(rows.map((row) => [row.event_type, row.contact_id, row.payload]), [
      ["lead.created", contact, { channel: "sms", source: "message" }],
    ]);
  });

  it("a drain at any point of the race never sees the losing contact: no event, no run", async () => {
    const leadJourney: JourneySnapshot = {
      nodes: [
        { id: "t", type: "trigger", name: "New lead", description: "", config: { event: "lead.created", filters: [] } },
        { id: "w", type: "action", name: "Wait", description: "", config: { action: "wait", duration: 1, unit: "days" } },
      ],
      connections: [{ id: "c", sourceNodeId: "t", targetNodeId: "w", sourceHandle: null, targetHandle: null }],
    };
    store.saveJourney(tenant, "j-lead", leadJourney);
    // Intake inserts the contact as the service role without event headers, so it records nothing until its identity is attached.
    const { data: inserted } = await service.from("contacts").insert({ tenant_id: tenant, lead_status: "New", record_type: "lead" }).select("id").single();
    const loser = inserted!.id as string;
    store.contacts.set(loser, { tenantId: tenant, lead: { lead_status: "New", record_type: "lead" } });
    assert.deepEqual(await drain(), [], "between the contact insert and the identity insert");
    assert.equal(await attachIntakeIdentity(service, { contactId: contact, channel: "sms", externalId: "15550001111" }), "attached");
    assert.equal(await attachIntakeIdentity(service, { contactId: loser, channel: "sms", externalId: "15550001111" }), "conflict");
    assert.deepEqual(await drain(), ["started"]);
    assert.deepEqual(runs().map((run) => run.contactId), [contact]);
    assert.deepEqual(await drain(), []);
  });

  it("a comment intake records source comment with the DM channel", async () => {
    assert.equal(await attachIntakeIdentity(service, { contactId: contact, channel: "instagram_comment", externalId: "ig-c-1" }), "attached");
    const [row] = await db.query<{ payload: unknown }>("select payload from public.journey_events");
    assert.deepEqual(row.payload, { channel: "instagram", source: "comment" });
  });
});
