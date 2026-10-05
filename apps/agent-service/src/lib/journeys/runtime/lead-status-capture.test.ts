/**
 * The contacts trigger from migration 055, on a real Postgres (PGlite). Writers
 * are exercised through supabase-js with the same query shape, client role, and
 * origin headers as the production code named in each test, so the event comes
 * from the database transition, never from the caller.
 */

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, beforeEach, describe, it } from "node:test";
import { DEFAULT_CONTACT_TYPE } from "../../crm/contact-type.ts";
import {
  STATUS_ACTOR_HEADER,
  STATUS_ORIGIN_HEADER,
  STATUS_RUN_HEADER,
  statusOriginHeaders,
  withStatusOrigin,
} from "../../crm/status-origin.ts";
import type { ActionInput } from "./engine.ts";
import { createTestDb, type TestDb } from "./lead-status-test-db.ts";
import { executeUpdateLead, type LeadUpdateStore } from "./update-lead.ts";

interface EventRow {
  id: string;
  tenant_id: string;
  contact_id: string;
  from_status: string | null;
  to_status: string;
  origin: string;
  actor_user_id: string | null;
  origin_run_id: string | null;
  converted: boolean;
  changed_at: Date;
  dispatched_at: Date | null;
  attempt_count: number;
}

let db: TestDb;
let tenant: string;
const USER = randomUUID();

before(async () => {
  db = await createTestDb();
});

after(async () => {
  await db.pg.close();
});

beforeEach(async () => {
  await db.reset();
  tenant = await newTenant();
});

async function newTenant(): Promise<string> {
  const [row] = await db.query<{ id: string }>("insert into public.tenants default values returning id");
  return row.id;
}

async function newLead(tenantId: string, fields: { lead_status?: string; record_type?: string; contact_type?: string } = {}) {
  const [row] = await db.query<{ id: string }>(
    `insert into public.contacts (tenant_id, lead_status, record_type, contact_type, first_name)
     values ($1, $2, $3, $4, 'Ana') returning id`,
    [tenantId, fields.lead_status ?? "New", fields.record_type ?? "lead", fields.contact_type ?? null],
  );
  return row.id;
}

async function events(contactId?: string): Promise<EventRow[]> {
  return contactId
    ? db.query<EventRow>("select * from public.lead_status_events where contact_id = $1 order by created_at, id", [contactId])
    : db.query<EventRow>("select * from public.lead_status_events order by created_at, id");
}

async function contact(contactId: string) {
  const [row] = await db.query<{ lead_status: string; record_type: string; contact_type: string | null }>(
    "select lead_status, record_type, contact_type from public.contacts where id = $1",
    [contactId],
  );
  return row;
}

function ok<T extends { error: { message: string } | null }>(result: T): T {
  assert.equal(result.error, null, result.error?.message);
  return result;
}

describe("contacts trigger", () => {
  it("New → Working creates one pending event with the previous and new status", async () => {
    const lead = await newLead(tenant);
    await db.query("update public.contacts set lead_status = 'Working' where id = $1", [lead]);

    const [event, ...rest] = await events(lead);
    assert.equal(rest.length, 0);
    assert.equal(event.tenant_id, tenant);
    assert.equal(event.contact_id, lead);
    assert.equal(event.from_status, "New");
    assert.equal(event.to_status, "Working");
    assert.equal(event.converted, false);
    assert.ok(event.changed_at instanceof Date);
    assert.equal(event.dispatched_at, null);
    assert.equal(event.attempt_count, 0);
    assert.match(event.id, /^[0-9a-f-]{36}$/);
  });

  it("same → same creates no event, even when lead_status is in the update", async () => {
    const lead = await newLead(tenant, { lead_status: "Working" });
    await db.query("update public.contacts set lead_status = 'Working' where id = $1", [lead]);
    await db.query("update public.contacts set lead_status = 'Working', first_name = 'Bea' where id = $1", [lead]);
    assert.equal((await events(lead)).length, 0);
  });

  it("updates that don't touch lead_status and inserts create no event", async () => {
    const lead = await newLead(tenant, { lead_status: "Qualified" });
    await db.query("update public.contacts set first_name = 'Bea', intent = 'Buyer' where id = $1", [lead]);
    assert.equal((await events()).length, 0);
  });

  it("records each transition separately and in order", async () => {
    const lead = await newLead(tenant);
    for (const status of ["Working", "Contacted", "Qualified"]) {
      await db.query("update public.contacts set lead_status = $2 where id = $1", [lead, status]);
    }
    assert.deepEqual(
      (await events(lead)).map((event) => `${event.from_status}→${event.to_status}`),
      ["New→Working", "Working→Contacted", "Contacted→Qualified"],
    );
  });

  it("marks a change to Converted as converted, and nothing else", async () => {
    const lead = await newLead(tenant, { lead_status: "Qualified" });
    await db.query(
      "update public.contacts set lead_status = 'Converted', record_type = 'contact', contact_type = 'Prospect' where id = $1",
      [lead],
    );
    const [event] = await events(lead);
    assert.equal(event.to_status, "Converted");
    assert.equal(event.converted, true);
  });

  it("a bulk update creates one event per row that actually changed, each in its own tenant", async () => {
    const otherTenant = await newTenant();
    const a = await newLead(tenant, { lead_status: "New" });
    const b = await newLead(otherTenant, { lead_status: "New" });
    const c = await newLead(tenant, { lead_status: "Working" });
    await db.query("update public.contacts set lead_status = 'Working'");

    const rows = await events();
    assert.deepEqual(rows.map((row) => row.contact_id).sort(), [a, b].sort());
    assert.equal(rows.find((row) => row.contact_id === a)?.tenant_id, tenant);
    assert.equal(rows.find((row) => row.contact_id === b)?.tenant_id, otherTenant);
    assert.equal((await events(c)).length, 0);
  });
});

describe("origin", () => {
  it("defaults to system with no request context (SQL editor, cron, migrations)", async () => {
    const lead = await newLead(tenant);
    await db.query("update public.contacts set lead_status = 'Working' where id = $1", [lead]);
    const [event] = await events(lead);
    assert.equal(event.origin, "system");
    assert.equal(event.actor_user_id, null);
    assert.equal(event.origin_run_id, null);
  });

  it("defaults to system for a service-role request without origin headers", async () => {
    const lead = await newLead(tenant);
    ok(await db.client("service_role").from("contacts").update({ lead_status: "Working" }).eq("id", lead));
    assert.equal((await events(lead))[0].origin, "system");
  });

  it("records a signed-in user as user, with the JWT subject as actor", async () => {
    const lead = await newLead(tenant);
    ok(await db.client("authenticated", USER).from("contacts").update({ lead_status: "Working" }).eq("id", lead));
    const [event] = await events(lead);
    assert.equal(event.origin, "user");
    assert.equal(event.actor_user_id, USER);
  });

  it("ignores origin, actor, and run headers a signed-in user tries to set", async () => {
    const lead = await newLead(tenant);
    const query = db
      .client("authenticated", USER)
      .from("contacts")
      .update({ lead_status: "Working" })
      .eq("id", lead)
      .setHeader(STATUS_ORIGIN_HEADER, "journey")
      .setHeader(STATUS_ACTOR_HEADER, randomUUID())
      .setHeader(STATUS_RUN_HEADER, randomUUID());
    ok(await query);
    const [event] = await events(lead);
    assert.equal(event.origin, "user");
    assert.equal(event.actor_user_id, USER);
    assert.equal(event.origin_run_id, null);
  });

  it("accepts journey origin and run id from the service role", async () => {
    const lead = await newLead(tenant);
    const run = randomUUID();
    ok(
      await withStatusOrigin(db.client("service_role").from("contacts").update({ lead_status: "Qualified" }).eq("id", lead), {
        origin: "journey",
        originRunId: run,
      }),
    );
    const [event] = await events(lead);
    assert.equal(event.origin, "journey");
    assert.equal(event.origin_run_id, run);
  });

  it("falls back to system for an unknown origin and drops malformed ids", async () => {
    const lead = await newLead(tenant);
    const query = db
      .client("service_role")
      .from("contacts")
      .update({ lead_status: "Working" })
      .eq("id", lead)
      .setHeader(STATUS_ORIGIN_HEADER, "admin'; drop table contacts; --")
      .setHeader(STATUS_ACTOR_HEADER, "not-a-uuid")
      .setHeader(STATUS_RUN_HEADER, "also-not-a-uuid");
    ok(await query);
    const [event] = await events(lead);
    assert.equal(event.origin, "system");
    assert.equal(event.actor_user_id, null);
    assert.equal(event.origin_run_id, null);
  });

  it("origin doesn't leak between requests on the same connection", async () => {
    // PGlite has a single connection, so every request reuses it, like a pooled PostgREST connection.
    const a = await newLead(tenant);
    const b = await newLead(tenant);
    const c = await newLead(tenant);
    const run = randomUUID();
    const service = db.client("service_role");

    ok(
      await withStatusOrigin(service.from("contacts").update({ lead_status: "Working" }).eq("id", a), {
        origin: "journey",
        originRunId: run,
        actorUserId: USER,
      }),
    );
    ok(await service.from("contacts").update({ lead_status: "Working" }).eq("id", b));
    ok(await db.client("authenticated", USER).from("contacts").update({ lead_status: "Working" }).eq("id", c));

    const byContact = new Map((await events()).map((event) => [event.contact_id, event]));
    assert.deepEqual(
      [a, b, c].map((id) => {
        const event = byContact.get(id)!;
        return [event.origin, event.origin_run_id, event.actor_user_id];
      }),
      [
        ["journey", run, USER],
        ["system", null, null],
        ["user", null, USER],
      ],
    );
    const [session] = await db.query<{ headers: string | null; claims: string | null }>(
      "select current_setting('request.headers', true) as headers, current_setting('request.jwt.claims', true) as claims",
    );
    assert.ok(!session.headers, "request headers don't outlive the request transaction");
    assert.ok(!session.claims, "request claims don't outlive the request transaction");
  });

  it("keeps a run id only for journey origin", async () => {
    const lead = await newLead(tenant);
    ok(
      await withStatusOrigin(db.client("service_role").from("contacts").update({ lead_status: "Working" }).eq("id", lead), {
        origin: "ai_agent",
        originRunId: randomUUID(),
      }),
    );
    const [event] = await events(lead);
    assert.equal(event.origin, "ai_agent");
    assert.equal(event.origin_run_id, null);
  });

  it("statusOriginHeaders only emits allowed origins and well-formed UUIDs", () => {
    const run = randomUUID();
    assert.deepEqual(statusOriginHeaders({ origin: "journey", originRunId: run, actorUserId: "nope" }), {
      [STATUS_ORIGIN_HEADER]: "journey",
      [STATUS_RUN_HEADER]: run,
    });
    assert.deepEqual(statusOriginHeaders({ origin: "root" as never }), {});
  });
});

describe("outbox access", () => {
  it("members read only their own workspace's events", async () => {
    const otherTenant = await newTenant();
    const mine = await newLead(tenant);
    const theirs = await newLead(otherTenant);
    await db.query("update public.contacts set lead_status = 'Working'");
    await db.query("insert into public.test_memberships (user_id, tenant_id) values ($1, $2)", [USER, tenant]);

    const { data, error } = await db.client("authenticated", USER).from("lead_status_events").select("contact_id");
    assert.equal(error, null);
    assert.deepEqual(data, [{ contact_id: mine }]);
    assert.notEqual(mine, theirs);
  });

  it("signed-in users can't edit events or call the dispatcher functions", async () => {
    const lead = await newLead(tenant);
    await db.query("update public.contacts set lead_status = 'Working' where id = $1", [lead]);
    await db.query("insert into public.test_memberships (user_id, tenant_id) values ($1, $2)", [USER, tenant]);
    const client = db.client("authenticated", USER);

    const edit = await client.from("lead_status_events").update({ dispatched_at: new Date().toISOString() }).eq("contact_id", lead).select("id");
    assert.deepEqual(edit.data ?? [], []);
    const claim = await client.rpc("claim_lead_status_events", { p_limit: 10 });
    assert.match(claim.error?.message ?? "", /permission denied/);
    assert.equal((await events(lead))[0].dispatched_at, null);
  });
});

describe("status writers", () => {
  it("CRM Update Lead (updateLeadAction, signed-in client) → one user event", async () => {
    const lead = await newLead(tenant);
    ok(
      await db
        .client("authenticated", USER)
        .from("contacts")
        .update({ first_name: "Ana", last_name: "Lima", email: "ana@example.test", lead_status: "Contacted" })
        .eq("id", lead)
        .eq("tenant_id", tenant),
    );
    const rows = await events(lead);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].to_status, "Contacted");
    assert.equal(rows[0].origin, "user");
  });

  it("CRM status action (updateLeadStatusAction) converting a lead → one Converted event", async () => {
    const lead = await newLead(tenant, { lead_status: "Qualified" });
    ok(
      await db
        .client("authenticated", USER)
        .from("contacts")
        .update({ lead_status: "Converted", record_type: "contact", contact_type: DEFAULT_CONTACT_TYPE })
        .eq("id", lead)
        .eq("tenant_id", tenant),
    );
    const rows = await events(lead);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].from_status, "Qualified");
    assert.equal(rows[0].to_status, "Converted");
    assert.equal(rows[0].converted, true);
    assert.equal((await contact(lead)).record_type, "contact");
  });

  it("agent path (applyToolCalls → updateContactFields) → ai_agent event", async () => {
    const lead = await newLead(tenant);
    const agent = db.client("service_role");
    ok(await withStatusOrigin(agent.from("contacts").update({ intent: "Buyer", lead_status: "Working" }).eq("id", lead), { origin: "ai_agent" }));
    ok(await withStatusOrigin(agent.from("contacts").update({ ready_to_book: true, lead_status: "Qualified" }).eq("id", lead), { origin: "ai_agent" }));
    const rows = await events(lead);
    assert.deepEqual(rows.map((row) => [row.to_status, row.origin]), [["Working", "ai_agent"], ["Qualified", "ai_agent"]]);
  });

  it("opportunity stage sync (syncLeadStatusForStage, conditional update) → system event once", async () => {
    const lead = await newLead(tenant, { lead_status: "Working" });
    const sync = () =>
      db
        .client("service_role")
        .from("contacts")
        .update({ lead_status: "Qualified" })
        .eq("id", lead)
        .in("lead_status", ["New", "Working", "Contacted"])
        .select("id");
    ok(await sync());
    const again = ok(await sync());
    assert.deepEqual(again.data, []);
    const rows = await events(lead);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].origin, "system");
  });

  it("booking conversion produces one Converted event although several paths attempt it", async () => {
    const lead = await newLead(tenant, { lead_status: "Qualified" });
    const admin = db.client("service_role");
    // markConsultBooked → updateContactFields
    ok(
      await withStatusOrigin(
        admin
          .from("contacts")
          .update({ appt_booked: true, ready_to_book: false, lead_status: "Converted", record_type: "contact", contact_type: DEFAULT_CONTACT_TYPE })
          .eq("id", lead),
        { origin: "ai_agent" },
      ),
    );
    // ensureAccountOnAppointmentSet, twice (opportunity create + stage advance)
    for (let attempt = 0; attempt < 2; attempt++) {
      ok(
        await admin
          .from("contacts")
          .update({ record_type: "contact", contact_type: "Prospect", lead_status: "Converted" })
          .eq("id", lead)
          .neq("record_type", "contact"),
      );
    }
    // applyToolCalls with appt_booked again
    ok(await withStatusOrigin(admin.from("contacts").update({ appt_booked: true, lead_status: "Converted" }).eq("id", lead), { origin: "ai_agent" }));

    const rows = await events(lead);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].to_status, "Converted");
    assert.equal(rows[0].converted, true);
  });

  it("ensureAccountOnAppointmentSet alone converts with a system event", async () => {
    const lead = await newLead(tenant, { lead_status: "Working" });
    ok(
      await db
        .client("service_role")
        .from("contacts")
        .update({ record_type: "contact", contact_type: "Prospect", lead_status: "Converted" })
        .eq("id", lead)
        .neq("record_type", "contact"),
    );
    const rows = await events(lead);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].origin, "system");
    assert.equal(rows[0].converted, true);
  });

  it("Journey Update Lead (real executeUpdateLead, live-actions query shape) → journey event with run id", async () => {
    const lead = await newLead(tenant, { lead_status: "Contacted" });
    const admin = db.client("service_role");
    const store: LeadUpdateStore = {
      async updateFields(tenantId, contactId, patch, runId) {
        const { data, error } = await withStatusOrigin(
          admin.from("contacts").update(patch).eq("id", contactId).eq("tenant_id", tenantId).select("id"),
          { origin: "journey", originRunId: runId },
        );
        return { error: error?.message ?? null, matched: (data?.length ?? 0) > 0 };
      },
      async convertLeadToClient(tenantId, contactId, contactType) {
        const { data, error } = await admin
          .from("contacts")
          .update({ record_type: "contact", contact_type: contactType })
          .eq("id", contactId)
          .eq("tenant_id", tenantId)
          .eq("record_type", "lead")
          .select("id");
        return { error: error?.message ?? null, matched: (data?.length ?? 0) > 0 };
      },
      async logActivity() {},
    };
    const runId = randomUUID();
    const input: ActionInput = { tenantId: tenant, runId, nodeId: "u", contactId: lead, lead: { lead_status: "Contacted" }, opportunity: null };

    await executeUpdateLead({ action: "update_lead", fields: { lead_status: "Qualified" } }, input, store);
    const result = await executeUpdateLead({ action: "update_lead", fields: { lead_status: "Converted" } }, input, store);
    assert.deepEqual(result.output, { updated: ["lead_status"], converted: true });

    const rows = await events(lead);
    assert.deepEqual(rows.map((row) => [row.from_status, row.to_status, row.origin, row.origin_run_id, row.converted]), [
      ["Contacted", "Qualified", "journey", runId, false],
      ["Qualified", "Converted", "journey", runId, true],
    ]);
    assert.equal((await contact(lead)).record_type, "contact");
  });

  it("import update (signed-in client, import origin): a changed status creates an import event", async () => {
    const lead = await newLead(tenant, { lead_status: "New" });
    ok(
      await withStatusOrigin(
        db
          .client("authenticated", USER)
          .from("contacts")
          .update({ first_name: "Ana", last_name: null, email: null, lead_status: "Contacted" })
          .eq("id", lead)
          .eq("tenant_id", tenant),
        { origin: "import" },
      ),
    );
    const rows = await events(lead);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].origin, "import");
    assert.equal(rows[0].actor_user_id, USER);
  });

  it("import update with an unchanged status creates no event", async () => {
    const lead = await newLead(tenant, { lead_status: "Contacted" });
    ok(
      await withStatusOrigin(
        db
          .client("authenticated", USER)
          .from("contacts")
          .update({ first_name: "Ana", last_name: "Lima", email: null, lead_status: "Contacted" })
          .eq("id", lead)
          .eq("tenant_id", tenant),
        { origin: "import" },
      ),
    );
    assert.equal((await events(lead)).length, 0);
  });

  it("merge (mergeContacts field patch) → merge event", async () => {
    const winner = await newLead(tenant, { lead_status: "Working" });
    ok(
      await withStatusOrigin(
        db
          .client("service_role")
          .from("contacts")
          .update({ appt_booked: true, ready_to_book: false, lead_status: "Converted", record_type: "contact", contact_type: "Prospect" })
          .eq("id", winner),
        { origin: "merge" },
      ),
    );
    const [event] = await events(winner);
    assert.equal(event.origin, "merge");
    assert.equal(event.converted, true);
  });
});
