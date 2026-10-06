import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { failureForStatus, failureForThrown, outcomeOf } from "./provider-outcome.ts";
import { signUnsubscribeToken, unsubscribeSecret, unsubscribeTokenContactId, verifyUnsubscribeToken } from "../email/unsubscribe-token.ts";
import { mustVerifyWebhookSignature } from "../env.ts";

describe("provider outcome classification", () => {
  it("a 4xx (other than 408) is a rejection: nothing was sent", () => {
    for (const status of [400, 401, 403, 404, 409, 422, 429]) {
      assert.deepEqual(failureForStatus(status, "bad number"), { ok: false, outcome: "rejected", error: "bad number" });
    }
    assert.equal(failureForStatus(422, null).error, "HTTP 422");
  });

  it("a 408 or 5xx is unknown: the message may have been sent", () => {
    for (const status of [408, 500, 502, 503, 504]) {
      const failure = failureForStatus(status, "upstream");
      assert.equal(failure.outcome, "unknown", String(status));
      assert.match(failure.error, /may have been sent/);
    }
  });

  it("a thrown request (timeout, network) is unknown", () => {
    const timeout = Object.assign(new Error("aborted"), { name: "TimeoutError" });
    assert.deepEqual(failureForThrown(timeout), {
      ok: false,
      outcome: "unknown",
      error: "The provider request timed out; the message may have been sent.",
    });
    assert.equal(failureForThrown(new TypeError("fetch failed")).outcome, "unknown");
    assert.match(failureForThrown("weird").error, /failed without a response/);
  });

  it("outcomes map to row statuses: accepted is sent (not delivered), rejected is failed, unknown stays unknown", () => {
    assert.deepEqual(outcomeOf({ ok: true, providerMessageId: "p-1" }), { status: "sent", providerMessageId: "p-1" });
    assert.deepEqual(outcomeOf({ ok: true, providerMessageId: null }), { status: "sent", providerMessageId: null });
    assert.deepEqual(outcomeOf({ ok: false, outcome: "rejected", error: "no" }), { status: "failed", error: "no" });
    assert.deepEqual(outcomeOf({ ok: false, outcome: "unknown", error: "?" }), { status: "unknown", error: "?" });
  });
});

describe("email unsubscribe tokens", () => {
  const secret = "test-secret";
  const tenantA = "tenant-a";
  const tenantB = "tenant-b";
  const contactId = "1b4e28ba-2fa1-11d2-883f-0016d3cca427";

  it("a signed token verifies for its own tenant and names its contact", () => {
    const token = signUnsubscribeToken(secret, tenantA, contactId);
    assert.equal(verifyUnsubscribeToken(secret, token, tenantA), true);
    assert.equal(unsubscribeTokenContactId(token), contactId);
    assert.equal(token.includes(tenantA), false, "the tenant isn't in the link");
  });

  it("a token doesn't verify for another tenant, another secret, another contact, or after tampering", () => {
    const token = signUnsubscribeToken(secret, tenantA, contactId);
    assert.equal(verifyUnsubscribeToken(secret, token, tenantB), false);
    assert.equal(verifyUnsubscribeToken("other-secret", token, tenantA), false);
    const otherContact = "2b4e28ba-2fa1-11d2-883f-0016d3cca427";
    assert.equal(verifyUnsubscribeToken(secret, `${otherContact}.${token.split(".")[1]}`, tenantA), false);
    assert.equal(verifyUnsubscribeToken(secret, `${token}x`, tenantA), false);
    assert.equal(verifyUnsubscribeToken(secret, `${contactId}.`, tenantA), false);
  });

  it("malformed tokens are rejected without throwing", () => {
    for (const token of ["", "nope", "not-a-uuid.sig", `${contactId}.sig.extra`, `${contactId}`]) {
      assert.equal(unsubscribeTokenContactId(token) === null || !verifyUnsubscribeToken(secret, token, tenantA), true, token);
      assert.equal(verifyUnsubscribeToken(secret, token, tenantA), false, token);
    }
  });

  it("outside production the secret prefers EMAIL_UNSUBSCRIBE_SECRET, then the platform key, then the service role key", () => {
    for (const NODE_ENV of [undefined, "development", "test"]) {
      assert.equal(unsubscribeSecret({ NODE_ENV, EMAIL_UNSUBSCRIBE_SECRET: "a", PLATFORM_SECRETS_ENCRYPTION_KEY: "b", SUPABASE_SERVICE_ROLE_KEY: "c" }), "a");
      assert.equal(unsubscribeSecret({ NODE_ENV, PLATFORM_SECRETS_ENCRYPTION_KEY: "b", SUPABASE_SERVICE_ROLE_KEY: "c" }), "b");
      assert.equal(unsubscribeSecret({ NODE_ENV, EMAIL_UNSUBSCRIBE_SECRET: "  ", SUPABASE_SERVICE_ROLE_KEY: "c" }), "c");
      assert.equal(unsubscribeSecret({ NODE_ENV }), null);
    }
  });

  it("production requires EMAIL_UNSUBSCRIBE_SECRET: no fallback, even when the other keys are set", () => {
    assert.equal(unsubscribeSecret({ NODE_ENV: "production", EMAIL_UNSUBSCRIBE_SECRET: "a", PLATFORM_SECRETS_ENCRYPTION_KEY: "b" }), "a");
    assert.equal(unsubscribeSecret({ NODE_ENV: "production", PLATFORM_SECRETS_ENCRYPTION_KEY: "b", SUPABASE_SERVICE_ROLE_KEY: "c" }), null);
    assert.equal(unsubscribeSecret({ NODE_ENV: "production", EMAIL_UNSUBSCRIBE_SECRET: "   ", SUPABASE_SERVICE_ROLE_KEY: "c" }), null);
  });

  it("rotation: a token signed with the previous secret doesn't verify under the new one", () => {
    const token = signUnsubscribeToken("old-secret", tenantA, contactId);
    assert.equal(verifyUnsubscribeToken("new-secret", token, tenantA), false);
  });
});

describe("webhook signature guard", () => {
  function withNodeEnv(value: string, run: () => void) {
    const env = process.env as Record<string, string | undefined>;
    const previous = env.NODE_ENV;
    env.NODE_ENV = value;
    try {
      run();
    } finally {
      env.NODE_ENV = previous;
    }
  }

  it("production always verifies, even when skipping was requested or no secret is configured", () => {
    withNodeEnv("production", () => {
      assert.equal(mustVerifyWebhookSignature(true), true);
      assert.equal(mustVerifyWebhookSignature(false), true);
    });
  });

  it("outside production, verification can be skipped for local work", () => {
    withNodeEnv("development", () => {
      assert.equal(mustVerifyWebhookSignature(true), false);
      assert.equal(mustVerifyWebhookSignature(false), true);
    });
  });
});
