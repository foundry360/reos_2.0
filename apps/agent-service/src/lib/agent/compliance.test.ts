import { describe, it } from "node:test";
import assert from "node:assert/strict";

import type { AgentBackend } from "./backend.ts";
import type { ContactContext } from "../coordinator.ts";
import { applyCompliance, isOptInMessage, isOptOutMessage, OPT_IN_REPLY, OPT_OUT_REPLY } from "./compliance.ts";

describe("opt-out keywords", () => {
  it("STOP and the other universal keywords opt out on every channel, whatever the case, spacing, or trailing punctuation", () => {
    for (const body of ["STOP", "stop", " Stop ", "STOP.", "stop!", "Stop!!", "unsubscribe", "Remove  me", "do not text", "Not interested."]) {
      for (const channel of ["sms", "messenger", "instagram"]) {
        assert.equal(isOptOutMessage(body, channel), true, `${JSON.stringify(body)} on ${channel}`);
      }
    }
  });

  it("CANCEL, END, QUIT, and STOPALL opt out over SMS only", () => {
    for (const body of ["CANCEL", "cancel", " End ", "quit.", "STOPALL"]) {
      assert.equal(isOptOutMessage(body, "sms"), true, body);
      assert.equal(isOptOutMessage(body, "messenger"), false, body);
      assert.equal(isOptOutMessage(body, "instagram"), false, body);
    }
  });

  it("a keyword inside a longer message is never an opt-out", () => {
    for (const body of [
      "cancel appointment",
      "Cancel my appointment",
      "end appointment",
      "End of the month works",
      "can you stop by at 3?",
      "please don't stop",
      "stop sign on the corner",
      "start time?",
    ]) {
      for (const channel of ["sms", "messenger", "instagram"]) {
        assert.equal(isOptOutMessage(body, channel), false, `${JSON.stringify(body)} on ${channel}`);
      }
    }
  });

  it("the default channel is SMS (the historical behavior)", () => {
    assert.equal(isOptOutMessage("cancel"), true);
  });
});

describe("opt-in keywords", () => {
  it("START and UNSTOP opt back in over SMS only", () => {
    for (const body of ["START", "start", " Start! ", "unstop", "UNSTOP."]) {
      assert.equal(isOptInMessage(body, "sms"), true, body);
      assert.equal(isOptInMessage(body, "messenger"), false, body);
      assert.equal(isOptInMessage(body, "instagram"), false, body);
    }
    assert.equal(isOptInMessage("start the process", "sms"), false);
    assert.equal(isOptInMessage("restart", "sms"), false);
  });
});

function fakeBackend() {
  const patches: Array<{ contactId: string; patch: Record<string, unknown> }> = [];
  const backend = {
    patchContact: async (contactId: string, patch: Record<string, unknown>) => {
      patches.push({ contactId, patch });
    },
  } as unknown as AgentBackend;
  return { backend, patches };
}

function contact(optedOut: boolean): ContactContext {
  return { contactId: "contact-1", optedOut } as unknown as ContactContext;
}

describe("applyCompliance", () => {
  it("STOP opts the contact out and sends only the opt-out confirmation", async () => {
    const { backend, patches } = fakeBackend();
    assert.deepEqual(await applyCompliance(backend, contact(false), " stop ", "sms"), { blocked: true, reply: OPT_OUT_REPLY, optedOut: true });
    assert.deepEqual(patches, [{ contactId: "contact-1", patch: { opted_out: true, ready_to_book: false } }]);
  });

  it("'cancel appointment' and 'end appointment' reach the agent and change nothing", async () => {
    for (const body of ["cancel appointment", "end appointment", "Cancel appointment please"]) {
      const { backend, patches } = fakeBackend();
      assert.deepEqual(await applyCompliance(backend, contact(false), body, "sms"), { blocked: false });
      assert.equal(patches.length, 0);
    }
  });

  it("CANCEL in a Messenger DM is an ordinary message, not an opt-out", async () => {
    const { backend, patches } = fakeBackend();
    assert.deepEqual(await applyCompliance(backend, contact(false), "cancel", "messenger"), { blocked: false });
    assert.equal(patches.length, 0);
  });

  it("an opted-out contact who texts START is subscribed again and told so", async () => {
    const { backend, patches } = fakeBackend();
    const ctx = contact(true);
    assert.deepEqual(await applyCompliance(backend, ctx, "START", "sms"), { blocked: true, reply: OPT_IN_REPLY, optedOut: false });
    assert.deepEqual(patches, [{ contactId: "contact-1", patch: { opted_out: false } }]);
    assert.equal(ctx.optedOut, false);
  });

  it("an opted-out contact's other messages stay silent: no reply, no agent, no change", async () => {
    for (const [body, channel] of [["hello?", "sms"], ["START", "messenger"], ["start", "instagram"]]) {
      const { backend, patches } = fakeBackend();
      assert.deepEqual(await applyCompliance(backend, contact(true), body, channel), { blocked: true, reply: "", optedOut: true });
      assert.equal(patches.length, 0);
    }
  });

  it("START from a subscribed contact is an ordinary message", async () => {
    const { backend, patches } = fakeBackend();
    assert.deepEqual(await applyCompliance(backend, contact(false), "start", "sms"), { blocked: false });
    assert.equal(patches.length, 0);
  });
});
