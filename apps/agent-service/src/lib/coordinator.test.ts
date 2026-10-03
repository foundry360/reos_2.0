import { test } from "node:test";
import assert from "node:assert/strict";
import {
  lastOutboundWasSchedulingPrompt,
  looksLikeInfoQuestion,
  looksLikeSchedulingMessage,
  resolvePlaybook,
  wantsToSchedule,
  type ContactContext,
} from "./coordinator.ts";

const baseCtx: ContactContext = {
  phone: "",
  leadStatus: "New",
  readyToBook: false,
  apptBooked: false,
  handoff: false,
  optedOut: false,
};

test("viewing requests count as schedule intent", () => {
  for (const body of [
    "Can we see it tomorrow morning?",
    "Can I tour the house Saturday?",
    "I'd like to see the property",
    "Could we schedule a private showing?",
    "Can we set up a tour?",
  ]) {
    assert.equal(wantsToSchedule(body), true, body);
    assert.equal(looksLikeInfoQuestion(body), false, body);
  }
});

test("general questions are not schedule intent", () => {
  for (const body of [
    "What are the HOA fees?",
    "Is it still available?",
    "Can you see the lake from the backyard?",
  ]) {
    assert.equal(wantsToSchedule(body), false, body);
  }
});

test("agent asking when they're available is a scheduling prompt", () => {
  assert.equal(
    lastOutboundWasSchedulingPrompt(
      "Great, I've got your contact info. Let's set up a private showing for you at 3041 Oatland Court. When are you available to see the property?",
    ),
    true,
  );
  assert.equal(looksLikeSchedulingMessage("Saturday around 2"), true);
});

test("schedule intent routes to scheduler even before intake is complete", () => {
  const body = "Can we see it tomorrow morning?";
  assert.equal(resolvePlaybook(baseCtx, body), "scheduler");
  assert.equal(resolvePlaybook({ ...baseCtx, readyToBook: true }, body), "scheduler");
});
