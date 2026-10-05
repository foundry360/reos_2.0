/**
 * Journey "Send Messenger" / "Send Instagram": the real executeSendMessage and
 * engine with the in-memory journey store. The delivery layer is replaced by a
 * fake that records each DM it's asked to send, so no message ever goes out.
 */

import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";
import type { DeliverMessageResult } from "../../messaging/deliver-message.ts";
import type { JourneyAIExecutor } from "./ai.ts";
import {
  dispatchJourneyEvent,
  LEASE_MS,
  resumeDueRuns,
  RETRY_BACKOFF_MS,
  type ActionExecutor,
  type EngineDeps,
} from "./engine.ts";
import type { JourneySnapshot, SnapshotNode } from "./graph.ts";
import { MemoryJourneyStore } from "./memory-store.ts";
import { executeSendMessage, type DirectMessageChannel } from "./send-message.ts";

const TENANT = "tenant-a";
const LEAD = "contact-1";

type Delivery = { tenantId: string; contactId: string; channel: DirectMessageChannel; body: string };

let store: MemoryJourneyStore;
let deps: EngineDeps;
let clock: Date;
let deliveries: Delivery[];
let replies: DeliverMessageResult[];
let otherActions: string[];

const noAI: JourneyAIExecutor = { execute: async () => ({ success: true, output: {}, text: "" }) };

beforeEach(() => {
  store = new MemoryJourneyStore();
  clock = new Date("2026-10-01T12:00:00Z");
  deliveries = [];
  replies = [];
  otherActions = [];
  store.contacts.set(LEAD, { tenantId: TENANT, lead: { first_name: "Ana", last_name: "Lima", record_type: "lead" } });
  const actions: ActionExecutor = {
    async execute(action, input) {
      if (action.action === "send_messenger" || action.action === "send_instagram") {
        return executeSendMessage(action.action === "send_messenger" ? "messenger" : "instagram", action, input, async (message) => {
          deliveries.push(message);
          return replies.shift() ?? { ok: true, messageId: `msg-${deliveries.length}`, recordType: "lead" };
        });
      }
      otherActions.push(action.action);
      return { status: "completed", output: {} };
    },
  };
  deps = { store, actions, ai: noAI, now: () => new Date(clock) };
});

const trigger: SnapshotNode = { id: "t", type: "trigger", name: "New lead", description: "", config: { event: "lead.created", filters: [] } };
const task: SnapshotNode = { id: "k", type: "action", name: "Task", description: "", config: { action: "create_task", title: "Call", notes: "", dueInDays: 1 } };
const dm = (action: "send_messenger" | "send_instagram"): SnapshotNode => ({
  id: "dm",
  type: "action",
  name: "DM",
  description: "",
  config: { action, body: "  Hi {{first_name}}, thanks for reaching out!  " },
});

function chain(...nodes: SnapshotNode[]): JourneySnapshot {
  return {
    nodes,
    connections: nodes.slice(1).map((node, index) => ({
      id: `${nodes[index].id}-${node.id}`,
      sourceNodeId: nodes[index].id,
      targetNodeId: node.id,
      sourceHandle: null,
      targetHandle: null,
    })),
  };
}

async function start(journey: JourneySnapshot) {
  store.saveJourney(TENANT, "j1", journey);
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

const theRun = () => [...store.runs.values()][0];
const dmSteps = () =>
  store.stepsFor(theRun().id).filter((step) => step.nodeId === "dm").map(({ status, output, error, errorKind, attemptCount }) => ({
    status,
    output,
    error,
    errorKind,
    attemptCount,
  }));

const CHANNELS = [
  { action: "send_messenger", channel: "messenger" },
  { action: "send_instagram", channel: "instagram" },
] as const;

for (const { action, channel } of CHANNELS) {
  describe(`Journey ${action}`, () => {
    it("delivers the rendered DM on its channel, records the output, and the journey completes", async () => {
      const run = await start(chain(trigger, dm(action), task));

      assert.deepEqual(deliveries, [{ tenantId: TENANT, contactId: LEAD, channel, body: "Hi Ana, thanks for reaching out!" }]);
      assert.deepEqual(dmSteps(), [
        {
          status: "completed",
          output: { message_id: "msg-1", channel, body: "Hi Ana, thanks for reaching out!" },
          error: undefined,
          errorKind: undefined,
          attemptCount: 1,
        },
      ]);
      assert.equal(run.status, "completed");
      assert.deepEqual(otherActions, ["create_task"]);
    });

    it("a configuration failure fails the step without a retry and stops the journey", async () => {
      const error = `This record has no ${channel} identity.`;
      replies.push({ ok: false, kind: "config", error });

      const run = await start(chain(trigger, dm(action), task));

      assert.deepEqual(dmSteps(), [{ status: "failed", output: undefined, error, errorKind: "config", attemptCount: 1 }]);
      assert.equal(run.status, "failed");
      assert.equal(run.error, error);
      assert.equal(run.resumeAt, null);

      clock = new Date(clock.getTime() + RETRY_BACKOFF_MS[0]);
      await resumeDueRuns(deps);
      assert.equal(deliveries.length, 1, "no retry");
      assert.deepEqual(otherActions, [], "later steps don't run");
    });

    it("a temporary provider failure goes through the existing step retry, which delivers", async () => {
      replies.push({ ok: false, kind: "transient", error: "Meta is temporarily unavailable." });

      const run = await start(chain(trigger, dm(action), task));

      assert.equal(run.status, "waiting");
      assert.equal(run.resumeAt, new Date(clock.getTime() + RETRY_BACKOFF_MS[0]).toISOString());
      assert.deepEqual(otherActions, []);

      clock = new Date(clock.getTime() + RETRY_BACKOFF_MS[0]);
      await resumeDueRuns(deps);

      assert.equal(deliveries.length, 2);
      assert.ok(deliveries.every((delivery) => delivery.channel === channel));
      assert.deepEqual(dmSteps().map(({ status, errorKind, attemptCount }) => ({ status, errorKind, attemptCount })), [
        { status: "failed", errorKind: "transient", attemptCount: 1 },
        { status: "completed", errorKind: undefined, attemptCount: 2 },
      ]);
      assert.equal(theRun().status, "completed");
      assert.deepEqual(otherActions, ["create_task"]);
    });
  });
}

describe("Journey send_messenger: duplicate-action protection", () => {
  it("recovers a DM whose step couldn't be recorded without sending it again", async () => {
    const updateStep = store.updateStep.bind(store);
    let pending = true;
    store.updateStep = async (stepId, patch) => {
      const step = store.steps.find((entry) => entry.id === stepId);
      if (pending && step?.nodeId === "dm" && patch.status === "completed") {
        pending = false;
        throw new Error("connection reset");
      }
      return updateStep(stepId, patch);
    };
    const wait: SnapshotNode = { id: "w", type: "action", name: "Wait", description: "", config: { action: "wait", duration: 1, unit: "days" } };

    await start(chain(trigger, wait, dm("send_messenger"), task));
    clock = new Date(clock.getTime() + 24 * 60 * 60_000);
    const failedPass = await resumeDueRuns(deps);

    assert.equal(failedPass.errors, 1, "the bookkeeping failure surfaces as an error");
    assert.equal(deliveries.length, 1);
    assert.equal(theRun().status, "running");
    assert.equal(theRun().context.inFlight?.outcome?.status, "completed");
    assert.equal(dmSteps()[0].status, "running");

    clock = new Date(clock.getTime() + LEASE_MS + 60_000);
    await resumeDueRuns(deps);

    assert.equal(deliveries.length, 1, "the DM isn't sent again");
    assert.deepEqual(dmSteps(), [
      {
        status: "completed",
        output: { message_id: "msg-1", channel: "messenger", body: "Hi Ana, thanks for reaching out!" },
        error: undefined,
        errorKind: undefined,
        attemptCount: 1,
      },
    ]);
    assert.equal(theRun().status, "completed");
    assert.equal(theRun().context.inFlight, undefined);
    assert.deepEqual(otherActions, ["create_task"]);
  });
});
