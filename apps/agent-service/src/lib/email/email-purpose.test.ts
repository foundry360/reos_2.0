import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { unsubscribeBlocks, type EmailPurpose } from "./email-purpose.ts";

describe("email purpose and unsubscribe", () => {
  const cases: [EmailPurpose, boolean][] = [
    ["marketing", true],
    ["conversational", true],
    ["transactional", false],
    ["operational", false],
  ];
  for (const [purpose, blocked] of cases) {
    it(`an unsubscribe ${blocked ? "stops" : "doesn't stop"} ${purpose} email`, () => {
      assert.equal(unsubscribeBlocks(purpose), blocked);
    });
  }

  it("an unrecognised purpose is never exempt", () => {
    assert.equal(unsubscribeBlocks("receipt" as EmailPurpose), true);
  });
});
