import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildResendPayload } from "./resend-payload.ts";

describe("buildResendPayload", () => {
  it("uses the verified REOS sender and authenticated agent reply-to", () => {
    const { payload, fromName } = buildResendPayload({
      senderEmail: "agent@verified-reos.example",
      senderProductName: "REOS",
      agentName: "Sarah Johnson",
      agentEmail: "sarah@gmail.com",
      to: [{ name: "John Smith", email: "john@gmail.com" }],
      cc: [],
      subject: "Following up",
      bodyHtml: "<p>Hello John</p>",
    });

    assert.equal(fromName, "Sarah Johnson");
    assert.equal(
      payload.from,
      "Sarah Johnson <agent@verified-reos.example>",
    );
    assert.equal(payload.reply_to, "sarah@gmail.com");
    assert.deepEqual(payload.to, ["John Smith <john@gmail.com>"]);
    assert.equal(payload.cc, undefined);
  });

  it("sanitizes display names before building headers", () => {
    const { payload } = buildResendPayload({
      senderEmail: "agent@verified-reos.example",
      senderProductName: "REOS",
      agentName: "Sarah\r\nBcc: attacker@example.com",
      agentEmail: "sarah@outlook.com",
      to: [{ email: "customer@yahoo.com" }],
      cc: [{ name: "Team\nMember", email: "team@example.com" }],
      subject: "Hello",
      bodyHtml: "<p>Hello</p>",
    });

    assert.equal(payload.from.includes("\r"), false);
    assert.equal(payload.from.includes("\n"), false);
    assert.equal(payload.reply_to, "sarah@outlook.com");
    assert.deepEqual(payload.cc, ["Team Member <team@example.com>"]);
  });
});
