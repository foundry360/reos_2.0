import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { composerAfterSend, draftContent, identityForSend, newDraftIdentity, NOT_CONFIRMED_NOTICE } from "./compose-draft.ts";

let counter = 0;
const fresh = () => `id-${++counter}`;

describe("composer draft identity", () => {
  it("the first send, a repeat of the same content, and a retry keep the identity", () => {
    const first = identityForSend(newDraftIdentity("a"), draftContent("sms", "Hi"), fresh);
    assert.deepEqual(first, { id: "a", submitted: "sms\nHi" });
    assert.deepEqual(identityForSend(first, draftContent("sms", "Hi"), fresh), first);
  });

  it("different text or a different channel gets a new identity", () => {
    const first = identityForSend(newDraftIdentity("a"), draftContent("sms", "Hi"), fresh);
    const edited = identityForSend(first, draftContent("sms", "Hi Ana"), fresh);
    assert.notEqual(edited.id, "a");
    assert.equal(edited.submitted, "sms\nHi Ana");
    assert.notEqual(identityForSend(first, draftContent("messenger", "Hi"), fresh).id, "a");
  });
});

describe("composer after a send", () => {
  it("sent clears the draft and starts a new identity", () => {
    assert.deepEqual(composerAfterSend({ outcome: "sent", messageId: "m1" }), {
      draft: "clear",
      newIdentity: true,
      bubble: { status: "sent", messageId: "m1" },
      notice: null,
    });
  });

  it("not sent keeps the draft and its identity for a retry", () => {
    const next = composerAfterSend({ outcome: "not_sent", error: "Rejected.", messageId: "m1" });
    assert.equal(next.draft, "restore");
    assert.equal(next.newIdentity, false);
    assert.deepEqual(next.bubble, { status: "failed", messageId: "m1" });
    assert.match(next.notice ?? "", /^Not sent/);
  });

  it("not confirmed doesn't put the text back as a draft, retires the identity, and says so", () => {
    for (const sendStatus of ["unknown", "pending"] as const) {
      const next = composerAfterSend({ outcome: "not_confirmed", error: "", messageId: "m1", sendStatus });
      assert.equal(next.draft, "clear");
      assert.equal(next.newIdentity, true);
      assert.deepEqual(next.bubble, { status: sendStatus, messageId: "m1" });
      assert.equal(next.notice, NOT_CONFIRMED_NOTICE);
    }
  });

  it("nothing recorded keeps the draft and removes the bubble", () => {
    const next = composerAfterSend({ outcome: "not_attempted", error: "Opted out." });
    assert.deepEqual(next, { draft: "restore", newIdentity: false, bubble: null, notice: "Opted out." });
  });

  it("a draft conflict keeps the text under a new identity", () => {
    const next = composerAfterSend({ outcome: "draft_conflict", error: "Used." });
    assert.deepEqual(next, { draft: "restore", newIdentity: true, bubble: null, notice: "Used." });
  });
});
