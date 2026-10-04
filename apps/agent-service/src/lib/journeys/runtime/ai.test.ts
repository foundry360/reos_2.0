import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";
import {
  AI_TEXT_KEY,
  createJourneyAIExecutor,
  journeyAIStepOutput,
  parseJourneyAIResponse,
  type AIPrompt,
  type ConversationMessage,
  type JourneyAIRequest,
} from "./ai.ts";

function request(overrides: Partial<JourneyAIRequest> = {}): JourneyAIRequest {
  return {
    tenantId: "tenant-a",
    journeyId: "j1",
    runId: "run-1",
    nodeId: "ai",
    stepKey: "qualify",
    contactId: "contact-1",
    agent: "default",
    goal: "Is this lead sales ready?",
    instructions: "Return sales_ready (boolean), score (0-100), and reason.",
    context: {
      lead: { id: "contact-1", first_name: "Ana", lead_status: "Working" },
      opportunity: { stage: "Qualified" },
      trigger: { event: "message.received", payload: { channel: "sms", body: "Can we tour Saturday?" } },
      steps: { assign: { output: { action: "assign_lead", ok: true } } },
    },
    ...overrides,
  };
}

let prompts: AIPrompt[];
let replies: Array<string | Error>;
let configured: boolean;
let conversationCalls: Array<{ tenantId: string; contactId: string }>;
let conversation: ConversationMessage[] | Error;

const executor = () =>
  createJourneyAIExecutor({
    model: {
      isConfigured: async () => configured,
      async complete(prompt) {
        prompts.push(prompt);
        const next = replies.shift() ?? "{}";
        if (next instanceof Error) throw next;
        return next;
      },
    },
    conversation: {
      async recent(tenantId, contactId) {
        conversationCalls.push({ tenantId, contactId });
        if (conversation instanceof Error) throw conversation;
        return conversation;
      },
    },
    now: () => new Date("2026-10-01T12:00:00Z"),
  });

beforeEach(() => {
  prompts = [];
  replies = [];
  configured = true;
  conversationCalls = [];
  conversation = [
    { role: "user", content: "Hi, I saw the listing on Oak St." },
    { role: "assistant", content: "Happy to help! Are you pre-approved?" },
    { role: "user", content: "Yes, up to 650k." },
  ];
});

describe("successful execution", () => {
  it("returns the structured output and explanation", async () => {
    replies.push(JSON.stringify({ output: { sales_ready: true, score: 82, reason: "Pre-approved" }, text: "Ready." }));
    const result = await executor().execute(request());
    assert.deepEqual(result, { success: true, output: { sales_ready: true, score: 82, reason: "Pre-approved" }, text: "Ready." });
  });

  it("builds the prompt from the goal, instructions, CRM context, earlier steps, and conversation", async () => {
    replies.push(JSON.stringify({ output: { sales_ready: true }, text: "" }));
    await executor().execute(request());
    const [{ system, user }] = prompts;
    assert.match(system, /JSON/);
    assert.match(system, /cannot send messages/);
    assert.match(user, /GOAL: Is this lead sales ready\?/);
    assert.match(user, /Return sales_ready \(boolean\), score \(0-100\), and reason\./);
    assert.match(user, /"first_name":"Ana"/);
    assert.match(user, /"stage":"Qualified"/);
    assert.match(user, /TRIGGER: message\.received .*Can we tour Saturday\?/);
    assert.match(user, /EARLIER STEPS: .*"assign_lead"/);
    assert.match(user, /Lead: Yes, up to 650k\./);
    assert.match(user, /Team: Happy to help! Are you pre-approved\?/);
  });

  it("persists structured fields at the top level with the explanation under ai_response", () => {
    assert.deepEqual(journeyAIStepOutput({ output: { score: 82 }, text: "Strong lead." }), {
      score: 82,
      [AI_TEXT_KEY]: "Strong lead.",
    });
    assert.deepEqual(journeyAIStepOutput({ output: { score: 82 }, text: "" }), { score: 82 });
  });
});

describe("response parsing", () => {
  it("normalizes keys so conditions can reference them", () => {
    const parsed = parseJourneyAIResponse(
      JSON.stringify({ output: { salesReady: true, "Lead Score": 70, [AI_TEXT_KEY]: "spoofed" }, text: "ok" }),
    );
    assert.deepEqual(parsed, { output: { sales_ready: true, lead_score: 70 }, text: "ok" });
  });

  it("accepts a bare object without the output envelope", () => {
    assert.deepEqual(parseJourneyAIResponse('{"sales_ready": false, "text": "Not yet."}'), {
      output: { sales_ready: false },
      text: "Not yet.",
    });
  });

  it("keeps values JSON-compatible and bounded", () => {
    const parsed = parseJourneyAIResponse(
      JSON.stringify({ output: { tags: ["buyer", "hot"], long: "x".repeat(5000), nothing: null } }),
    )!;
    assert.deepEqual(parsed.output.tags, ["buyer", "hot"]);
    assert.equal((parsed.output.long as string).length, 2000);
    assert.equal(parsed.output.nothing, null);
  });

  it("rejects non-JSON and non-object answers", () => {
    assert.equal(parseJourneyAIResponse("Sure! The lead is ready."), null);
    assert.equal(parseJourneyAIResponse("[1,2]"), null);
  });
});

describe("failures", () => {
  it("reports model errors as retryable failures", async () => {
    replies.push(new Error("Request timed out."));
    assert.deepEqual(await executor().execute(request()), {
      success: false,
      retryable: true,
      error: "Request timed out.",
    });
  });

  it("reports unparseable or empty answers as retryable failures", async () => {
    replies.push("not json", "{}");
    const first = await executor().execute(request());
    const second = await executor().execute(request());
    assert.deepEqual(first, { success: false, retryable: true, error: "The AI response wasn't valid JSON." });
    assert.deepEqual(second, { success: false, retryable: true, error: "The AI returned an empty result." });
  });

  it("fails without retrying when AI isn't configured, without calling the model", async () => {
    configured = false;
    const result = await executor().execute(request());
    assert.deepEqual(result, { success: false, retryable: false, error: "AI isn't configured for REOS yet." });
    assert.equal(prompts.length, 0);
  });

  it("fails without retrying for an unknown agent key", async () => {
    const result = await executor().execute(request({ agent: "someone_else" }));
    assert.equal(result.success, false);
    assert.equal(result.success === false && result.retryable, false);
    assert.equal(prompts.length, 0);
  });

  it("reports a conversation lookup failure as retryable", async () => {
    conversation = new Error("connection reset");
    const result = await executor().execute(request());
    assert.deepEqual(result, { success: false, retryable: true, error: "connection reset" });
    assert.equal(prompts.length, 0);
  });
});

describe("workspace isolation", () => {
  it("reads conversation history for the run's workspace and lead", async () => {
    replies.push('{"output": {"sales_ready": true}}');
    await executor().execute(request());
    assert.deepEqual(conversationCalls, [{ tenantId: "tenant-a", contactId: "contact-1" }]);
  });

  it("doesn't read conversation history when the lead isn't in the run's workspace", async () => {
    replies.push('{"output": {"sales_ready": false}}');
    const base = request();
    await executor().execute(request({ tenantId: "tenant-b", context: { ...base.context, lead: null, opportunity: null } }));
    assert.deepEqual(conversationCalls, []);
    assert.match(prompts[0].user, /LEAD: none/);
    assert.match(prompts[0].user, /RECENT CONVERSATION: none/);
  });

  it("doesn't read conversation history for runs without a lead", async () => {
    replies.push('{"output": {"ok": true}}');
    await executor().execute(request({ contactId: null }));
    assert.deepEqual(conversationCalls, []);
  });
});
