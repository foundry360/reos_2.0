import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  signMeetingJoinToken,
  verifyMeetingJoinToken,
} from "./meeting-join.ts";

describe("meeting join tokens", () => {
  it("round-trips a signed host token", () => {
    process.env.MEETING_JOIN_SECRET = "test-meeting-join-secret";
    const exp = Math.floor(Date.now() / 1000) + 3600;
    const token = signMeetingJoinToken({
      activityId: "11111111-1111-1111-1111-111111111111",
      tenantId: "22222222-2222-2222-2222-222222222222",
      role: "host",
      exp,
    });
    const payload = verifyMeetingJoinToken(token);
    assert.ok(payload);
    assert.equal(payload.role, "host");
    assert.equal(payload.activityId, "11111111-1111-1111-1111-111111111111");
  });
});
