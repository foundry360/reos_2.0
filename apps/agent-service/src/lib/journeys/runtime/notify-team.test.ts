/**
 * Journey "Notify team": the real notifyMembers (over an in-memory stand-in for
 * memberships, notification_preferences, and user_notifications), the real
 * executeNotifyTeam, and the real engine with the in-memory journey store.
 */

import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";
import type { SupabaseClient } from "@supabase/supabase-js";
import { notifyMembers } from "../../notifications/notify-members.ts";
import type { JourneyAIExecutor } from "./ai.ts";
import { dispatchJourneyEvent, resumeDueRuns, RETRY_BACKOFF_MS, type ActionExecutor, type EngineDeps } from "./engine.ts";
import type { JourneySnapshot } from "./graph.ts";
import { MemoryJourneyStore } from "./memory-store.ts";
import { executeNotifyTeam } from "./notify-team.ts";

const TENANT = "tenant-a";
const OTHER_TENANT = "tenant-b";
const LEAD = "contact-1";

type Row = Record<string, unknown>;

/** Just the query shapes notifyMembers uses: select/eq/in reads and a multi-row insert. */
class FakeNotificationDb {
  tables: Record<string, Row[]> = { memberships: [], notification_preferences: [], user_notifications: [] };
  failInsert: string | null = null;
  failMembers: string | null = null;
  throwOnInsert = false;

  from(table: string) {
    const filters: Array<(row: Row) => boolean> = [];
    const read = () => {
      if (table === "memberships" && this.failMembers) return { data: null, error: { message: this.failMembers } };
      return { data: this.tables[table].filter((row) => filters.every((filter) => filter(row))), error: null };
    };
    const query = {
      select: () => query,
      eq: (column: string, value: unknown) => {
        filters.push((row) => row[column] === value);
        return query;
      },
      in: (column: string, values: unknown[]) => {
        filters.push((row) => values.includes(row[column]));
        return query;
      },
      then: (resolve: (value: unknown) => unknown, reject: (reason: unknown) => unknown) =>
        Promise.resolve().then(read).then(resolve, reject),
      insert: async (rows: Row[]) => {
        if (this.throwOnInsert) throw new Error("fetch failed");
        if (this.failInsert) return { error: { message: this.failInsert } };
        this.tables[table].push(...rows);
        return { error: null };
      },
    };
    return query;
  }

  member(userId: string, tenantId = TENANT) {
    this.tables.memberships.push({ tenant_id: tenantId, user_id: userId });
  }

  leadsInApp(userId: string, enabled: boolean) {
    this.tables.notification_preferences.push({
      user_id: userId,
      tasks_in_app: true,
      leads_in_app: enabled,
      opportunities_in_app: true,
      messages_in_app: true,
      system_in_app: true,
    });
  }

  notified() {
    return this.tables.user_notifications.map((row) => row.user_id);
  }
}

/** Trigger → Notify → Task */
function notifyJourney(recipients: "assigned_agent" | "all_members"): JourneySnapshot {
  return {
    nodes: [
      { id: "t", type: "trigger", name: "New lead", description: "", config: { event: "lead.created", filters: [] } },
      {
        id: "n",
        type: "action",
        name: "Notify",
        description: "",
        config: { action: "notify_team", title: "New lead {{first_name}}", body: "Call them", recipients },
      },
      { id: "k", type: "action", name: "Task", description: "", config: { action: "create_task", title: "Call", notes: "", dueInDays: 1 } },
    ],
    connections: [
      { id: "t-n", sourceNodeId: "t", targetNodeId: "n", sourceHandle: null, targetHandle: null },
      { id: "n-k", sourceNodeId: "n", targetNodeId: "k", sourceHandle: null, targetHandle: null },
    ],
  };
}

const noAI: JourneyAIExecutor = { execute: async () => ({ success: true, output: {}, text: "" }) };

let db: FakeNotificationDb;
let store: MemoryJourneyStore;
let deps: EngineDeps;
let clock: Date;
let assignedAgent: string | null;
let otherActions: string[];

beforeEach(() => {
  db = new FakeNotificationDb();
  store = new MemoryJourneyStore();
  clock = new Date("2026-10-01T12:00:00Z");
  assignedAgent = null;
  otherActions = [];
  store.contacts.set(LEAD, { tenantId: TENANT, lead: { first_name: "Ana", record_type: "lead" } });
  const actions: ActionExecutor = {
    async execute(action, input) {
      if (action.action === "notify_team") {
        return executeNotifyTeam(action, input, {
          assignedAgentUserId: async () => assignedAgent,
          notify: (notification) => notifyMembers(db as unknown as SupabaseClient, notification),
        });
      }
      otherActions.push(action.action);
      return { status: "completed", output: {} };
    },
  };
  deps = { store, actions, ai: noAI, now: () => new Date(clock) };
});

async function start(recipients: "assigned_agent" | "all_members") {
  store.saveJourney(TENANT, "j1", notifyJourney(recipients));
  await dispatchJourneyEvent(deps, {
    tenantId: TENANT,
    type: "lead.created",
    sourceId: LEAD,
    contactId: LEAD,
    entityType: "contact",
    entityId: LEAD,
    payload: {},
  });
  return [...store.runs.values()][0];
}

const notifySteps = (runId: string) =>
  store.stepsFor(runId).filter((step) => step.nodeId === "n").map(({ status, output, error, errorKind, attemptCount }) => ({
    status,
    output,
    error,
    errorKind,
    attemptCount,
  }));

describe("Notify team: success", () => {
  it("notifies every eligible member, records how many, and the journey continues to completion", async () => {
    db.member("u1");
    db.member("u2");

    const run = await start("all_members");

    assert.deepEqual(db.notified().sort(), ["u1", "u2"]);
    assert.deepEqual(db.tables.user_notifications[0], {
      user_id: db.tables.user_notifications[0].user_id,
      tenant_id: TENANT,
      category: "leads",
      title: "New lead Ana",
      body: "Call them",
      href: `/leads/${LEAD}`,
    });
    assert.deepEqual(notifySteps(run.id), [{ status: "completed", output: { notified: 2 }, error: undefined, errorKind: undefined, attemptCount: 1 }]);
    assert.equal(run.status, "completed");
    assert.deepEqual(otherActions, ["create_task"]);
  });
});

describe("Notify team: recipients (unchanged)", () => {
  it("assigned agent: notifies only the lead's agent", async () => {
    db.member("u1");
    db.member("agent");
    assignedAgent = "agent";

    const run = await start("assigned_agent");

    assert.deepEqual(db.notified(), ["agent"]);
    assert.deepEqual(notifySteps(run.id)[0].output, { notified: 1 });
    assert.equal(run.status, "completed");
  });

  it("assigned agent: no assigned agent fails the step as a configuration error", async () => {
    db.member("u1");

    const run = await start("assigned_agent");

    assert.deepEqual(db.notified(), []);
    assert.equal(notifySteps(run.id)[0].status, "failed");
    assert.equal(notifySteps(run.id)[0].error, "The lead has no assigned agent to notify.");
    assert.equal(notifySteps(run.id)[0].errorKind, "config");
    assert.equal(run.status, "failed");
  });

  it("all members: skips members who turned lead notifications off and members of other workspaces", async () => {
    db.member("u1");
    db.member("u2");
    db.member("u3");
    db.member("outsider", OTHER_TENANT);
    db.leadsInApp("u2", false);
    db.leadsInApp("u3", true);

    const run = await start("all_members");

    assert.deepEqual(db.notified().sort(), ["u1", "u3"]);
    assert.deepEqual(notifySteps(run.id)[0].output, { notified: 2 });
  });
});

describe("Notify team: nobody to notify is a failure, not a success", () => {
  const cases: Array<{ name: string; recipients: "assigned_agent" | "all_members"; setup: () => void; error: string }> = [
    {
      name: "the workspace has no members",
      recipients: "all_members",
      setup: () => db.member("outsider", OTHER_TENANT),
      error: "This workspace has no team members to notify.",
    },
    {
      name: "every member turned lead notifications off",
      recipients: "all_members",
      setup: () => {
        db.member("u1");
        db.leadsInApp("u1", false);
      },
      error: "Every team member has in-app lead notifications turned off.",
    },
    {
      name: "the assigned agent turned lead notifications off",
      recipients: "assigned_agent",
      setup: () => {
        db.member("agent");
        db.leadsInApp("agent", false);
        assignedAgent = "agent";
      },
      error: "The lead's assigned agent has in-app lead notifications turned off.",
    },
    {
      name: "the assigned agent left the workspace",
      recipients: "assigned_agent",
      setup: () => {
        db.member("agent", OTHER_TENANT);
        assignedAgent = "agent";
      },
      error: "The lead's assigned agent isn't in this workspace anymore.",
    },
  ];

  for (const { name, recipients, setup, error } of cases) {
    it(`${name}: config failure, no notification, no completed step, nothing after it runs`, async () => {
      setup();
      const run = await start(recipients);

      assert.deepEqual(db.notified(), []);
      assert.deepEqual(notifySteps(run.id), [{ status: "failed", output: undefined, error, errorKind: "config", attemptCount: 1 }]);
      assert.equal(run.status, "failed");
      assert.equal(run.error, error);
      assert.deepEqual(otherActions, [], "the journey doesn't continue past the failed step");
    });
  }
});

describe("Notify team: a database failure is reported and retried by the existing step retries", () => {
  it("a failed insert fails the step as transient, schedules the existing retry, and the retry notifies", async () => {
    db.member("u1");
    db.failInsert = "connection reset";

    const run = await start("all_members");

    assert.deepEqual(db.notified(), []);
    assert.deepEqual(notifySteps(run.id), [
      { status: "failed", output: undefined, error: "Couldn't create the notification: connection reset", errorKind: "transient", attemptCount: 1 },
    ]);
    assert.equal(run.status, "waiting");
    assert.equal(run.resumeAt, new Date(clock.getTime() + RETRY_BACKOFF_MS[0]).toISOString());
    assert.deepEqual(otherActions, []);

    db.failInsert = null;
    clock = new Date(clock.getTime() + RETRY_BACKOFF_MS[0]);
    await resumeDueRuns(deps);

    assert.deepEqual(db.notified(), ["u1"]);
    assert.deepEqual(notifySteps(run.id).map(({ status, attemptCount }) => ({ status, attemptCount })), [
      { status: "failed", attemptCount: 1 },
      { status: "completed", attemptCount: 2 },
    ]);
    assert.equal(store.runs.get(run.id)!.status, "completed");
    assert.deepEqual(otherActions, ["create_task"]);
  });

  it("a failed membership read fails the step as transient", async () => {
    db.member("u1");
    db.failMembers = "permission denied";

    const run = await start("all_members");

    assert.equal(notifySteps(run.id)[0].errorKind, "transient");
    assert.equal(notifySteps(run.id)[0].error, "Couldn't create the notification: permission denied");
    assert.equal(run.status, "waiting");
  });

  it("an unexpected exception fails the step as transient (existing classification)", async () => {
    db.member("u1");
    db.throwOnInsert = true;

    const run = await start("all_members");

    assert.equal(notifySteps(run.id)[0].errorKind, "transient");
    assert.equal(notifySteps(run.id)[0].error, "fetch failed");
    assert.equal(run.status, "waiting");
  });

  it("a persistent failure stops after the existing maximum attempts", async () => {
    db.member("u1");
    db.failInsert = "connection reset";

    const run = await start("all_members");
    for (const delay of RETRY_BACKOFF_MS) {
      clock = new Date(clock.getTime() + delay);
      await resumeDueRuns(deps);
    }

    assert.deepEqual(notifySteps(run.id).map(({ status, attemptCount }) => ({ status, attemptCount })), [
      { status: "failed", attemptCount: 1 },
      { status: "failed", attemptCount: 2 },
      { status: "failed", attemptCount: 3 },
    ]);
    assert.equal(store.runs.get(run.id)!.status, "failed");
    assert.deepEqual(db.notified(), []);
  });
});
