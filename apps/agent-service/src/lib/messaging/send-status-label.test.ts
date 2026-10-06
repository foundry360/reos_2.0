import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  PENDING_DISPLAY_WINDOW_MS,
  parseDeliveryStatus,
  presentDeliveryStatus,
  presentSendStatus,
} from "./send-status-label.ts";
import { PROVIDER_SEND_TIMEOUT_MS } from "./provider-outcome.ts";

const CREATED = "2026-10-06T12:00:00.000Z";
const at = (ms: number) => Date.parse(CREATED) + ms;

describe("send status presentation", () => {
  it("a pending record reads Sending… only while the provider call could still be in flight", () => {
    assert.ok(PENDING_DISPLAY_WINDOW_MS > PROVIDER_SEND_TIMEOUT_MS);
    assert.deepEqual(presentSendStatus("pending", CREATED, at(0)), { label: "Sending…", problem: false });
    assert.deepEqual(presentSendStatus("pending", CREATED, at(PENDING_DISPLAY_WINDOW_MS - 1)), { label: "Sending…", problem: false });
  });

  it("a stale pending record reads Not confirmed, never sent", () => {
    for (const elapsed of [PENDING_DISPLAY_WINDOW_MS, PENDING_DISPLAY_WINDOW_MS + 1, 86_400_000]) {
      assert.deepEqual(presentSendStatus("pending", CREATED, at(elapsed)), { label: "Not confirmed", problem: true });
    }
  });

  it("a pending record with no usable time reads Not confirmed", () => {
    for (const createdAt of [null, undefined, "", "not a date"]) {
      assert.deepEqual(presentSendStatus("pending", createdAt, at(0)), { label: "Not confirmed", problem: true });
    }
  });

  it("failed reads Not sent and unknown reads Not confirmed, however recent", () => {
    assert.deepEqual(presentSendStatus("failed", CREATED, at(0)), { label: "Not sent", problem: true });
    assert.deepEqual(presentSendStatus("unknown", CREATED, at(0)), { label: "Not confirmed", problem: true });
  });

  it("sent and legacy statusless records carry no label", () => {
    assert.equal(presentSendStatus("sent", CREATED, at(0)), null);
    assert.equal(presentSendStatus(null, CREATED, at(0)), null);
    assert.equal(presentSendStatus(undefined, null, at(0)), null);
  });
});

describe("email delivery presentation", () => {
  it("names what happened after Resend accepted the email; negative outcomes are problems", () => {
    assert.deepEqual(presentDeliveryStatus("delivered"), { label: "Delivered", problem: false });
    assert.deepEqual(presentDeliveryStatus("delayed"), { label: "Delivery delayed", problem: false });
    assert.deepEqual(presentDeliveryStatus("bounced"), { label: "Not delivered (bounced)", problem: true });
    assert.deepEqual(presentDeliveryStatus("failed"), { label: "Not delivered", problem: true });
    assert.deepEqual(presentDeliveryStatus("suppressed"), { label: "Not delivered (suppressed)", problem: true });
    assert.deepEqual(presentDeliveryStatus("complained"), { label: "Marked as spam", problem: true });
    assert.equal(presentDeliveryStatus(null), null);
  });

  it("parses only known delivery statuses", () => {
    assert.equal(parseDeliveryStatus("bounced"), "bounced");
    for (const value of ["opened", "sent", "", null, 3]) assert.equal(parseDeliveryStatus(value), null);
  });
});
