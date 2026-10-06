import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  RESEND_WEBHOOK_TOLERANCE_SECONDS,
  resendWebhookHeaders,
  signResendWebhook,
  verifyResendWebhook,
} from "./resend-webhook-signature.ts";

const SECRET = `whsec_${Buffer.from("test-signing-key-material-0123456789").toString("base64")}`;
const OTHER_SECRET = `whsec_${Buffer.from("some-other-signing-key-material-xyz").toString("base64")}`;
const NOW = 1_800_000_000;
const BODY = JSON.stringify({ type: "email.delivered", data: { email_id: "re_1" } });

function headersFor(body = BODY, secret = SECRET, timestamp = String(NOW), id = "msg_1") {
  return { id, timestamp, signature: `v1,${signResendWebhook(secret, id, timestamp, body)}` };
}

describe("Resend webhook signature", () => {
  it("accepts a body signed with the secret", () => {
    assert.equal(verifyResendWebhook({ secret: SECRET, headers: headersFor(), body: BODY, nowSeconds: NOW }), true);
  });

  it("accepts any v1 signature in the list, as during secret rotation", () => {
    const valid = headersFor();
    const rotated = { ...valid, signature: `v1,${signResendWebhook(OTHER_SECRET, "msg_1", String(NOW), BODY)} ${valid.signature}` };
    assert.equal(verifyResendWebhook({ secret: SECRET, headers: rotated, body: BODY, nowSeconds: NOW }), true);
  });

  it("rejects a changed body, another secret, another id, or a missing signature", () => {
    assert.equal(verifyResendWebhook({ secret: SECRET, headers: headersFor(), body: `${BODY} `, nowSeconds: NOW }), false);
    assert.equal(verifyResendWebhook({ secret: SECRET, headers: headersFor(BODY, OTHER_SECRET), body: BODY, nowSeconds: NOW }), false);
    assert.equal(
      verifyResendWebhook({ secret: SECRET, headers: { ...headersFor(), id: "msg_2" }, body: BODY, nowSeconds: NOW }),
      false,
    );
    assert.equal(
      verifyResendWebhook({ secret: SECRET, headers: { ...headersFor(), signature: null }, body: BODY, nowSeconds: NOW }),
      false,
    );
    assert.equal(
      verifyResendWebhook({ secret: SECRET, headers: { ...headersFor(), signature: "v2,abc" }, body: BODY, nowSeconds: NOW }),
      false,
    );
  });

  it("rejects a timestamp outside the tolerance, in either direction", () => {
    const old = String(NOW - RESEND_WEBHOOK_TOLERANCE_SECONDS - 1);
    const future = String(NOW + RESEND_WEBHOOK_TOLERANCE_SECONDS + 1);
    assert.equal(verifyResendWebhook({ secret: SECRET, headers: headersFor(BODY, SECRET, old), body: BODY, nowSeconds: NOW }), false);
    assert.equal(verifyResendWebhook({ secret: SECRET, headers: headersFor(BODY, SECRET, future), body: BODY, nowSeconds: NOW }), false);
    assert.equal(
      verifyResendWebhook({ secret: SECRET, headers: { ...headersFor(), timestamp: "soon" }, body: BODY, nowSeconds: NOW }),
      false,
    );
  });

  it("rejects everything when the secret is empty", () => {
    assert.equal(verifyResendWebhook({ secret: "", headers: headersFor(), body: BODY, nowSeconds: NOW }), false);
    assert.equal(verifyResendWebhook({ secret: "whsec_", headers: headersFor(), body: BODY, nowSeconds: NOW }), false);
  });

  it("reads Svix headers, falling back to Standard Webhooks names", () => {
    assert.deepEqual(
      resendWebhookHeaders(new Headers({ "svix-id": "a", "svix-timestamp": "1", "svix-signature": "v1,x" })),
      { id: "a", timestamp: "1", signature: "v1,x" },
    );
    assert.deepEqual(
      resendWebhookHeaders(new Headers({ "webhook-id": "b", "webhook-timestamp": "2", "webhook-signature": "v1,y" })),
      { id: "b", timestamp: "2", signature: "v1,y" },
    );
  });
});
