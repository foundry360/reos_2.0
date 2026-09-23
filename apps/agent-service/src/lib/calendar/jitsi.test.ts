import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createMeetingRoomName, getJitsiBaseUrl } from "./jitsi.ts";

describe("createMeetingRoomName", () => {
  it("builds a stable reos room slug", () => {
    const room = createMeetingRoomName("Consult Call");
    assert.match(room, /^reos-consult-call-[a-f0-9]+$/);
    assert.equal(getJitsiBaseUrl(), "https://meet.jit.si");
  });
});
