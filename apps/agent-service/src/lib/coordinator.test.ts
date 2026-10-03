import { test } from "node:test";
import assert from "node:assert/strict";
import {
  lastOutboundOfferedTimes,
  lastOutboundWasSchedulingPrompt,
  looksLikeInfoQuestion,
  looksLikeSchedulingMessage,
  namesSpecificTime,
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

test("follow-ups after times were offered stay in scheduling", () => {
  const offered = "Sure! How about these options for later in the afternoon on Monday?\n\n1. 1:00 PM\n2. 1:30 PM\n3. 2:00 PM\n\nLet me know what works for you!";
  assert.equal(lastOutboundOfferedTimes(offered), true);
  assert.equal(lastOutboundWasSchedulingPrompt(offered), true);
  assert.equal(looksLikeInfoQuestion("Any time later in the day?"), false);
  assert.equal(resolvePlaybook({ ...baseCtx, readyToBook: true }, "Any time later in the day?"), "scheduler");
  assert.equal(resolvePlaybook({ ...baseCtx, readyToBook: true }, "Great, 2pm works for me"), "scheduler");
  assert.equal(
    lastOutboundOfferedTimes("Your showing is confirmed for Monday at 2:00 PM."),
    false,
  );
});

test("picking a specific time is detected, ruling one out is not", () => {
  for (const body of ["Great, 2pm works for me", "How about 10:30am?", "Lets do 11:30am", "10:00am"]) {
    assert.equal(namesSpecificTime(body), true, body);
  }
  for (const body of ["2pm doesn't work for me", "Not 10am", "Can't do 3 pm", "Any time later in the day?"]) {
    assert.equal(namesSpecificTime(body), false, body);
  }
});

test("schedule intent routes to scheduler even before intake is complete", () => {
  const body = "Can we see it tomorrow morning?";
  assert.equal(resolvePlaybook(baseCtx, body), "scheduler");
  assert.equal(resolvePlaybook({ ...baseCtx, readyToBook: true }, body), "scheduler");
});
